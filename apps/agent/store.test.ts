import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TaskStore } from "./store";

test("opens an existing database and adds follow-up columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-agent-schema-"));
  const path = join(dir, "tasks.sqlite");
  const old = new Database(path);
  old.run(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, userId TEXT, status TEXT, availableAt INTEGER, createdAt INTEGER, updatedAt INTEGER)",
  );
  old.close();
  const store = new TaskStore(path);
  try {
    const columns = store.db.query("PRAGMA table_info(tasks)").all() as {
      name: string;
    }[];
    const names = columns.map((column) => column.name);
    expect(names).toContain("phase");
    expect(names).toContain("previousReport");
    expect(names).toContain("followupCount");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isolates users and resumes a task from its saved checkpoint after worker failure", () => {
  const store = new TaskStore(":memory:");
  try {
    const first = store.createUser("Alice", ["alice/project"]);
    const second = store.createUser("Bob", ["bob/project"]);
    expect(store.userForKey(first.apiKey)?.id).toBe(first.user.id);
    expect(store.userForKey(second.apiKey)?.id).toBe(second.user.id);
    expect(() =>
      store.enqueue(second.user.id, {
        repo: "alice/project",
        task: "Edit README",
        model: "openrouter/free",
        maxSteps: 10,
      }),
    ).toThrow("allowlist");

    const task = store.enqueue(first.user.id, {
      repo: "alice/project",
      task: "Edit README",
      model: "openrouter/free",
      maxSteps: 10,
    });
    expect(store.getTaskForUser(task.id, second.user.id)).toBeNull();
    const now = Date.now() + 1;
    const claimed = store.claimNext("worker-a", now)!;
    expect(claimed.attempts).toBe(1);
    store.checkpoint(task.id, "worker-a", {
      originalHead: "a".repeat(40),
      baseBranch: "main",
      checkpointJson: '{"completedSteps":2}',
      patch: "saved patch",
      report: null,
    });
    expect(store.fail(task.id, "worker-a", "sandbox crashed", now)).toBe(
      "queued",
    );
    expect(store.claimNext("worker-b", now + 4_999)).toBeNull();
    const resumed = store.claimNext("worker-b", now + 5_000)!;
    expect(resumed.attempts).toBe(2);
    expect(resumed.checkpointJson).toBe('{"completedSteps":2}');
    expect(resumed.patch).toBe("saved patch");
    expect(store.heartbeat(task.id, "worker-b", now + 5_001)).toBe(true);
    store.complete(
      task.id,
      "worker-b",
      "Edited README",
      "https://github.com/alice/project/pull/1",
    );
    expect(store.getTask(task.id)?.status).toBe("succeeded");
  } finally {
    store.close();
  }
});

test("expired leases return to queue and stop at the attempt limit", () => {
  const store = new TaskStore(":memory:");
  try {
    const user = store.createUser("Alice", ["alice/project"]);
    const task = store.enqueue(user.user.id, {
      repo: "alice/project",
      task: "Edit README",
      model: "openrouter/free",
      maxSteps: 10,
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = store.claimNext(
        `worker-${attempt}`,
        Date.now() + attempt * 200_000,
      )!;
      expect(claimed.attempts).toBe(attempt);
      store.requeueExpired(claimed.leaseUntil! + 1);
      expect(store.getTask(task.id)?.status).toBe(
        attempt === 3 ? "failed" : "queued",
      );
    }
  } finally {
    store.close();
  }
});

test("permanent repository access errors fail without retrying", () => {
  const store = new TaskStore(":memory:");
  try {
    const user = store.createUser("Alice", ["alice/project"]);
    const task = store.enqueue(user.user.id, {
      repo: "alice/project",
      task: "Edit README",
      model: "openrouter/free",
      maxSteps: 10,
    });
    const claimed = store.claimNext("worker-a")!;
    expect(claimed.attempts).toBe(1);
    expect(
      store.fail(
        task.id,
        "worker-a",
        "App is not installed",
        Date.now(),
        false,
      ),
    ).toBe("failed");
    expect(store.getTask(task.id)?.attempts).toBe(1);
    expect(store.claimNext("worker-b")).toBeNull();
  } finally {
    store.close();
  }
});

test("instructions are delivered atomically with a checkpoint", () => {
  const store = new TaskStore(":memory:");
  try {
    const user = store.createUser("Alice", ["alice/project"]);
    const task = store.enqueue(user.user.id, {
      repo: "alice/project",
      task: "Edit README",
      model: "openrouter/free",
      maxSteps: 10,
    });
    const instruction = store.addInstruction(
      task.id,
      user.user.id,
      "Add examples",
    )!;
    expect(store.claimNext("worker-a")?.phase).toBe("preparing");
    expect(store.pendingInstructions(task.id, "worker-a")).toHaveLength(1);
    expect(store.reserveFinalization(task.id, "worker-a", [])).toBe(false);
    store.setProgress(task.id, "worker-a", "working", "Running a command", 1);
    store.checkpoint(task.id, "worker-a", {
      originalHead: "a".repeat(40),
      baseBranch: "main",
      checkpointJson: '{"completedSteps":1}',
      patch: null,
      report: null,
      deliveredInstructionIds: [instruction.id],
    });
    expect(store.listInstructions(task.id)[0]?.status).toBe("delivered");
    expect(store.pendingInstructions(task.id, "worker-a")).toHaveLength(0);
    expect(store.reserveFinalization(task.id, "worker-a", [])).toBe(true);
    const status = store.getTask(task.id)!;
    expect(status.phase).toBe("publishing");
    expect(status.currentStep).toBe(1);
    expect(status.activity).toBe("Preparing final result");
    expect(() =>
      store.addInstruction(task.id, user.user.id, "Too late"),
    ).toThrow("publishing");
  } finally {
    store.close();
  }
});

test("a completed task can be continued with its previous report and PR", () => {
  const store = new TaskStore(":memory:");
  try {
    const user = store.createUser("Alice", ["alice/project"]);
    const task = store.enqueue(user.user.id, {
      repo: "alice/project",
      task: "Improve README",
      model: "openrouter/free",
      maxSteps: 10,
    });
    store.claimNext("worker-a");
    store.setBranch(task.id, "worker-a", "cloud-agent/readme");
    store.complete(
      task.id,
      "worker-a",
      "Added setup instructions",
      "https://github.com/alice/project/pull/1",
    );
    const continued = store.continueTask(
      task.id,
      user.user.id,
      "Add a quickstart example",
    )!;
    expect(continued.status).toBe("queued");
    expect(continued.followupCount).toBe(1);
    expect(continued.previousReport).toBe("Added setup instructions");
    expect(continued.report).toBeNull();
    expect(continued.branch).toBe("cloud-agent/readme");
    expect(continued.prUrl).toBe("https://github.com/alice/project/pull/1");
    expect(continued.attempts).toBe(0);
    expect(store.listInstructions(task.id).at(-1)?.text).toBe(
      "Add a quickstart example",
    );
    expect(store.claimNext("worker-b")?.id).toBe(task.id);
  } finally {
    store.close();
  }
});

test("workers share capacity across users before taking a second task for one user", () => {
  const store = new TaskStore(":memory:");
  try {
    const alice = store.createUser("Alice", ["alice/project"]);
    const bob = store.createUser("Bob", ["bob/project"]);
    const first = store.enqueue(alice.user.id, {
      repo: "alice/project",
      task: "First",
      model: "openrouter/free",
      maxSteps: 10,
    });
    store.enqueue(alice.user.id, {
      repo: "alice/project",
      task: "Second",
      model: "openrouter/free",
      maxSteps: 10,
    });
    const other = store.enqueue(bob.user.id, {
      repo: "bob/project",
      task: "Other",
      model: "openrouter/free",
      maxSteps: 10,
    });
    const time = Date.now() + 1;
    const claimedA = store.claimNext("worker-a", time)!;
    const claimedB = store.claimNext("worker-b", time)!;
    expect(new Set([claimedA.userId, claimedB.userId])).toEqual(
      new Set([alice.user.id, bob.user.id]),
    );
  } finally {
    store.close();
  }
});
