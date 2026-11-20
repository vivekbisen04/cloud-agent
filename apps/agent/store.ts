import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed";
export type TaskPhase =
  | "queued"
  | "preparing"
  | "working"
  | "publishing"
  | "retrying"
  | "completed"
  | "failed";
export type TaskRow = {
  id: string;
  userId: string;
  repo: string;
  task: string;
  model: string;
  maxSteps: number;
  status: TaskStatus;
  phase: TaskPhase;
  currentStep: number;
  activity: string | null;
  progressAt: number | null;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  originalHead: string | null;
  baseBranch: string | null;
  checkpointJson: string | null;
  patch: string | null;
  branch: string | null;
  prUrl: string | null;
  report: string | null;
  previousReport: string | null;
  followupCount: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type UserRow = { id: string; name: string };
export type TaskInstruction = {
  id: string;
  taskId: string;
  text: string;
  status: "pending" | "delivered";
  createdAt: number;
  deliveredAt: number | null;
};

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class TaskStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, keyHash TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allowed_repos (
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        PRIMARY KEY (userId, repo)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id),
        repo TEXT NOT NULL, task TEXT NOT NULL, model TEXT NOT NULL, maxSteps INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL DEFAULT 3,
        availableAt INTEGER NOT NULL, leaseOwner TEXT, leaseUntil INTEGER,
        originalHead TEXT, baseBranch TEXT, checkpointJson TEXT, patch TEXT,
        branch TEXT, prUrl TEXT, report TEXT, error TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status, availableAt, createdAt);
      CREATE INDEX IF NOT EXISTS tasks_user ON tasks(userId, createdAt);
      CREATE TABLE IF NOT EXISTS task_instructions (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        createdAt INTEGER NOT NULL,
        deliveredAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS task_instructions_task ON task_instructions(taskId, createdAt);
    `);
    const columns = this.db.query("PRAGMA table_info(tasks)").all() as {
      name: string;
    }[];
    const existing = new Set(columns.map((column) => column.name));
    if (!existing.has("phase"))
      this.db.run(
        "ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'",
      );
    if (!existing.has("currentStep"))
      this.db.run(
        "ALTER TABLE tasks ADD COLUMN currentStep INTEGER NOT NULL DEFAULT 0",
      );
    if (!existing.has("activity"))
      this.db.run("ALTER TABLE tasks ADD COLUMN activity TEXT");
    if (!existing.has("progressAt"))
      this.db.run("ALTER TABLE tasks ADD COLUMN progressAt INTEGER");
    if (!existing.has("previousReport"))
      this.db.run("ALTER TABLE tasks ADD COLUMN previousReport TEXT");
    if (!existing.has("followupCount"))
      this.db.run(
        "ALTER TABLE tasks ADD COLUMN followupCount INTEGER NOT NULL DEFAULT 0",
      );
  }

  close() {
    this.db.close();
  }

  createUser(name: string, repos: string[]): { user: UserRow; apiKey: string } {
    const user = { id: randomUUID(), name };
    const apiKey = `ca_${randomBytes(32).toString("base64url")}`;
    const create = this.db.transaction(() => {
      this.db
        .query("INSERT INTO users (id,name,keyHash,createdAt) VALUES (?,?,?,?)")
        .run(user.id, name, hashKey(apiKey), Date.now());
      const insertRepo = this.db.query(
        "INSERT INTO allowed_repos (userId,repo) VALUES (?,?)",
      );
      for (const repo of new Set(repos.map((value) => value.toLowerCase())))
        insertRepo.run(user.id, repo);
    });
    create();
    return { user, apiKey };
  }

  userForKey(key: string): UserRow | null {
    return this.db
      .query("SELECT id,name FROM users WHERE keyHash = ?")
      .get(hashKey(key)) as UserRow | null;
  }

  addRepo(userId: string, repo: string): boolean {
    const user = this.db.query("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!user) return false;
    this.db
      .query("INSERT OR IGNORE INTO allowed_repos (userId,repo) VALUES (?,?)")
      .run(userId, repo.toLowerCase());
    return true;
  }

  allowedRepos(userId: string): string[] {
    return (
      this.db
        .query("SELECT repo FROM allowed_repos WHERE userId = ? ORDER BY repo")
        .all(userId) as { repo: string }[]
    ).map((row) => row.repo);
  }

  listUsers(): {
    id: string;
    name: string;
    createdAt: number;
    repos: string[];
  }[] {
    const users = this.db
      .query("SELECT id,name,createdAt FROM users ORDER BY createdAt DESC")
      .all() as { id: string; name: string; createdAt: number }[];
    return users.map((user) => ({
      ...user,
      repos: this.allowedRepos(user.id),
    }));
  }

  listAllTasks(): (TaskRow & { userName: string })[] {
    return this.db
      .query(
        `SELECT tasks.*, users.name AS userName FROM tasks
         JOIN users ON users.id = tasks.userId
         ORDER BY tasks.updatedAt DESC, tasks.createdAt DESC LIMIT 100`,
      )
      .all() as (TaskRow & { userName: string })[];
  }

  enqueue(
    userId: string,
    input: { repo: string; task: string; model: string; maxSteps: number },
  ): TaskRow {
    const allowed = this.db
      .query("SELECT 1 FROM allowed_repos WHERE userId = ? AND repo = ?")
      .get(userId, input.repo.toLowerCase());
    if (!allowed) throw new Error("Repository is not on this user's allowlist");
    const id = randomUUID();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO tasks (id,userId,repo,task,model,maxSteps,status,availableAt,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,'queued',?,?,?)`,
      )
      .run(
        id,
        userId,
        input.repo,
        input.task,
        input.model,
        input.maxSteps,
        now,
        now,
        now,
      );
    return this.getTask(id)!;
  }

  getTask(id: string): TaskRow | null {
    return this.db
      .query("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | null;
  }

  getTaskForUser(id: string, userId: string): TaskRow | null {
    return this.db
      .query("SELECT * FROM tasks WHERE id = ? AND userId = ?")
      .get(id, userId) as TaskRow | null;
  }

  listTasks(userId: string): TaskRow[] {
    return this.db
      .query(
        "SELECT * FROM tasks WHERE userId = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT 100",
      )
      .all(userId) as TaskRow[];
  }

  addInstruction(
    taskId: string,
    userId: string,
    text: string,
  ): TaskInstruction | null {
    return this.db.transaction(() => {
      const task = this.getTaskForUser(taskId, userId);
      if (!task) return null;
      if (task.status !== "queued" && task.status !== "running")
        throw new Error(
          "This task has finished. Create a new task for more work.",
        );
      if (task.phase === "publishing")
        throw new Error(
          "This task is publishing. Create a new task for more work.",
        );
      if (task.phase === "working" && task.currentStep >= task.maxSteps)
        throw new Error(
          "This task has reached its step limit. Create a new task for more work.",
        );
      if (task.checkpointJson) {
        let checkpoint: unknown;
        try {
          checkpoint = JSON.parse(task.checkpointJson);
        } catch {
          // A damaged checkpoint does not change whether the task is active.
        }
        if (
          checkpoint &&
          typeof checkpoint === "object" &&
          "finalReport" in checkpoint &&
          typeof checkpoint.finalReport === "string"
        )
          throw new Error(
            "This task is publishing. Create a new task for more work.",
          );
      }
      const count = this.db
        .query(
          "SELECT COUNT(*) AS count FROM task_instructions WHERE taskId = ?",
        )
        .get(taskId) as { count: number };
      if (count.count >= 100)
        throw new Error("This task has reached the 100-instruction limit.");
      const id = randomUUID();
      const now = Date.now();
      this.db
        .query(
          "INSERT INTO task_instructions (id,taskId,text,createdAt) VALUES (?,?,?,?)",
        )
        .run(id, taskId, text, now);
      return this.db
        .query("SELECT * FROM task_instructions WHERE id = ?")
        .get(id) as TaskInstruction;
    })();
  }

  continueTask(taskId: string, userId: string, text: string): TaskRow | null {
    return this.db.transaction(() => {
      const task = this.getTaskForUser(taskId, userId);
      if (!task) return null;
      if (task.status !== "succeeded")
        throw new Error("Only a completed task can be continued.");
      const count = this.db
        .query(
          "SELECT COUNT(*) AS count FROM task_instructions WHERE taskId = ?",
        )
        .get(taskId) as { count: number };
      if (count.count >= 100)
        throw new Error("This task has reached the 100-instruction limit.");
      const now = Date.now();
      const previousReport = [task.previousReport, task.report]
        .filter(Boolean)
        .join("\n\n---\n\n")
        .slice(-20_000);
      this.db
        .query(
          `UPDATE tasks SET status='queued', phase='queued', activity='Follow-up queued',
           progressAt=?, currentStep=0, attempts=0, availableAt=?, leaseOwner=NULL,
           leaseUntil=NULL, originalHead=NULL, checkpointJson=NULL, patch=NULL,
           report=NULL, previousReport=?, followupCount=followupCount+1,
           error=NULL, updatedAt=? WHERE id=? AND status='succeeded'`,
        )
        .run(now, now, previousReport, now, taskId);
      this.db
        .query(
          "INSERT INTO task_instructions (id,taskId,text,createdAt) VALUES (?,?,?,?)",
        )
        .run(randomUUID(), taskId, text, now);
      return this.getTask(taskId)!;
    })();
  }

  listInstructions(taskId: string): TaskInstruction[] {
    return this.db
      .query(
        "SELECT * FROM task_instructions WHERE taskId = ? ORDER BY createdAt, id LIMIT 100",
      )
      .all(taskId) as TaskInstruction[];
  }

  pendingInstructions(taskId: string, workerId: string): TaskInstruction[] {
    const task = this.getTask(taskId);
    if (!task || task.status !== "running" || task.leaseOwner !== workerId)
      throw new Error("Task lease was lost while reading instructions");
    return this.db
      .query(
        "SELECT * FROM task_instructions WHERE taskId = ? AND status = 'pending' ORDER BY createdAt, id",
      )
      .all(taskId) as TaskInstruction[];
  }

  requeueExpired(now = Date.now()): number {
    return this.db.transaction(() => {
      const exhausted = this.db
        .query(
          `UPDATE tasks SET status='failed', phase='failed', activity='Worker lease expired',
        progressAt=?, leaseOwner=NULL, leaseUntil=NULL,
        updatedAt=?, error='Worker lease expired after maximum attempts'
        WHERE status='running' AND leaseUntil < ? AND attempts >= maxAttempts`,
        )
        .run(now, now, now).changes;
      const retried = this.db
        .query(
          `UPDATE tasks SET status='queued', phase='retrying', activity='Waiting for a new worker',
        progressAt=?, leaseOwner=NULL, leaseUntil=NULL,
        availableAt=?, updatedAt=?, error='Worker lease expired; resuming from checkpoint'
        WHERE status='running' AND leaseUntil < ? AND attempts < maxAttempts`,
        )
        .run(now, now, now, now).changes;
      return exhausted + retried;
    })();
  }

  claimNext(workerId: string, now = Date.now()): TaskRow | null {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          `SELECT * FROM tasks AS candidate WHERE candidate.status='queued' AND candidate.availableAt <= ?
        AND NOT EXISTS (SELECT 1 FROM tasks AS active WHERE active.userId = candidate.userId AND active.status='running')
        ORDER BY candidate.createdAt, candidate.id LIMIT 1`,
        )
        .get(now) as TaskRow | null;
      if (!row) return null;
      this.db
        .query(
          `UPDATE tasks SET status='running', phase='preparing', activity='Starting worker',
        progressAt=?, attempts=attempts+1, leaseOwner=?,
        leaseUntil=?, updatedAt=? WHERE id=? AND status='queued'`,
        )
        .run(now, workerId, now + 120_000, now, row.id);
      return this.getTask(row.id);
    })();
  }

  setProgress(
    id: string,
    workerId: string,
    phase: "preparing" | "working" | "publishing",
    activity: string,
    currentStep?: number,
  ): void {
    const now = Date.now();
    const changed = this.db
      .query(
        `UPDATE tasks SET phase=?, activity=?, currentStep=COALESCE(?, currentStep),
        progressAt=?, updatedAt=? WHERE id=? AND leaseOwner=? AND status='running'`,
      )
      .run(
        phase,
        activity.slice(0, 200),
        currentStep ?? null,
        now,
        now,
        id,
        workerId,
      ).changes;
    if (changed !== 1)
      throw new Error("Task lease was lost while updating progress");
  }

  reserveFinalization(
    id: string,
    workerId: string,
    instructionIdsBeingDelivered: string[],
  ): boolean {
    return this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task || task.status !== "running" || task.leaseOwner !== workerId)
        throw new Error("Task lease was lost before finalization");
      const inFlight = new Set(instructionIdsBeingDelivered);
      const pending = this.db
        .query(
          "SELECT id FROM task_instructions WHERE taskId=? AND status='pending'",
        )
        .all(id) as { id: string }[];
      if (pending.some((item) => !inFlight.has(item.id))) return false;
      this.setProgress(id, workerId, "publishing", "Preparing final result");
      return true;
    })();
  }

  heartbeat(id: string, workerId: string, now = Date.now()): boolean {
    return (
      this.db
        .query(
          `UPDATE tasks SET leaseUntil=?, updatedAt=?
      WHERE id=? AND leaseOwner=? AND status='running'`,
        )
        .run(now + 120_000, now, id, workerId).changes === 1
    );
  }

  checkpoint(
    id: string,
    workerId: string,
    values: {
      originalHead: string;
      baseBranch: string;
      checkpointJson: string | null;
      patch: string | null;
      report: string | null;
      deliveredInstructionIds?: string[];
    },
  ): void {
    this.db.transaction(() => {
      const now = Date.now();
      const changed = this.db
        .query(
          `UPDATE tasks SET originalHead=?, baseBranch=?, checkpointJson=?,
        patch=?, report=?, updatedAt=? WHERE id=? AND leaseOwner=? AND status='running'`,
        )
        .run(
          values.originalHead,
          values.baseBranch,
          values.checkpointJson,
          values.patch,
          values.report,
          now,
          id,
          workerId,
        ).changes;
      if (changed !== 1)
        throw new Error("Task lease was lost while saving checkpoint");
      const delivered = this.db.query(
        `UPDATE task_instructions SET status='delivered', deliveredAt=?
         WHERE id=? AND taskId=? AND status='pending'`,
      );
      for (const instructionId of values.deliveredInstructionIds ?? []) {
        if (delivered.run(now, instructionId, id).changes !== 1)
          throw new Error("Instruction was changed before checkpoint");
      }
    })();
  }

  setBranch(id: string, workerId: string, branch: string): void {
    const changed = this.db
      .query(
        `UPDATE tasks SET branch=?, phase='publishing', activity='Publishing pull request',
        progressAt=?, updatedAt=?
      WHERE id=? AND leaseOwner=? AND status='running'`,
      )
      .run(branch, Date.now(), Date.now(), id, workerId).changes;
    if (changed !== 1)
      throw new Error("Task lease was lost before publication");
  }

  complete(
    id: string,
    workerId: string,
    report: string,
    prUrl: string | null,
  ): void {
    const changed = this.db
      .query(
        `UPDATE tasks SET status='succeeded', phase='completed', activity='Task complete',
      progressAt=?, report=?, prUrl=?, error=NULL,
      leaseOwner=NULL, leaseUntil=NULL, updatedAt=? WHERE id=? AND leaseOwner=? AND status='running'`,
      )
      .run(Date.now(), report, prUrl, Date.now(), id, workerId).changes;
    if (changed !== 1) throw new Error("Task lease was lost before completion");
  }

  fail(
    id: string,
    workerId: string,
    reason: string,
    now = Date.now(),
    retryable = true,
  ): TaskStatus {
    return this.db.transaction(() => {
      const row = this.getTask(id);
      if (!row || row.status !== "running" || row.leaseOwner !== workerId)
        throw new Error("Task lease was lost after failure");
      const retry = retryable && row.attempts < row.maxAttempts;
      const status: TaskStatus = retry ? "queued" : "failed";
      const delay = retry
        ? Math.min(60_000, 5_000 * 2 ** (row.attempts - 1))
        : 0;
      this.db
        .query(
          `UPDATE tasks SET status=?, phase=?, activity=?, progressAt=?, error=?,
        availableAt=?, leaseOwner=NULL, leaseUntil=NULL, updatedAt=? WHERE id=?`,
        )
        .run(
          status,
          retry ? "retrying" : "failed",
          retry ? "Waiting for a new worker" : "Task failed",
          now,
          reason.slice(0, 2000),
          now + delay,
          now,
          id,
        );
      return status;
    })();
  }
}

export function publicTask(row: TaskRow) {
  let completedSteps = 0;
  if (row.checkpointJson) {
    try {
      const checkpoint: unknown = JSON.parse(row.checkpointJson);
      if (
        checkpoint &&
        typeof checkpoint === "object" &&
        "completedSteps" in checkpoint &&
        typeof checkpoint.completedSteps === "number" &&
        Number.isInteger(checkpoint.completedSteps)
      ) {
        completedSteps = Math.max(0, checkpoint.completedSteps);
      }
    } catch {
      // Legacy or damaged checkpoints cannot block task status reads.
    }
  }
  return {
    id: row.id,
    repo: row.repo,
    task: row.task,
    model: row.model,
    maxSteps: row.maxSteps,
    status: row.status,
    phase: row.phase,
    activity: row.activity,
    currentStep: row.currentStep,
    completedSteps,
    progressAt: row.progressAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    branch: row.branch,
    prUrl: row.prUrl,
    report: row.report,
    previousReport: row.previousReport,
    followupCount: row.followupCount,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
