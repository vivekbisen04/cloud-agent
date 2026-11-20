import { randomUUID } from "node:crypto";
import { OpenRouter } from "@openrouter/sdk";
import { Sandbox } from "e2b";
import { runAgent, type AgentProgress } from "./agent";
import { branchName, shellQuote } from "./cli";
import { capturePatch, restorePatch } from "./checkpoint";
import {
  createInstallationToken,
  createPullRequest,
  findOpenPullRequest,
  getAppBotIdentity,
  getDefaultBranch,
  getRepositoryInstallationId,
  GitHubRepositoryAccessError,
  remoteBranchExists,
  revokeInstallationToken,
  type GitHubAppConfig,
} from "./github";
import { isFreeModel, rateLimitedSend, RequestPacer } from "./model-client";
import { TaskStore, type TaskRow } from "./store";

const REPO_PATH = "/home/user/repo";
const SANDBOX_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';

class GitHubContinuationError extends Error {}

export type WorkerConfig = {
  store: TaskStore;
  app: GitHubAppConfig;
  openRouterApiKey: string;
  count: number;
  log?: (message: string) => void;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function splitRepo(repo: string) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error("Invalid task repository");
  return { owner, name };
}

async function runTask(
  config: WorkerConfig,
  task: TaskRow,
  workerId: string,
  sandbox: Sandbox,
  freePacer: RequestPacer,
) {
  const { owner, name } = splitRepo(task.repo);
  config.store.setProgress(
    task.id,
    workerId,
    "preparing",
    "Checking repository access",
  );
  const installationId = await getRepositoryInstallationId(
    config.app,
    owner,
    name,
  );
  const token = (
    await createInstallationToken(config.app, installationId, name)
  ).token;
  try {
    config.store.setProgress(
      task.id,
      workerId,
      "preparing",
      "Cloning repository",
    );
    const bot = await getAppBotIdentity(config.app, token);
    const baseBranch =
      task.baseBranch ?? (await getDefaultBranch(token, owner, name));
    const cloneUrl = `https://github.com/${owner}/${name}.git`;
    const existingPr =
      task.branch && task.prUrl
        ? await findOpenPullRequest(token, owner, name, task.branch, baseBranch)
        : null;
    if (task.prUrl && !existingPr)
      throw new GitHubContinuationError(
        "The previous pull request is no longer open. Start a new task for this repository.",
      );
    const branchOption =
      task.branch && existingPr
        ? `--branch ${shellQuote(task.branch)} --single-branch `
        : "";
    await sandbox.commands.run(
      `git -c credential.helper= -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} clone ${branchOption}--depth 1 ${shellQuote(cloneUrl)} ${shellQuote(REPO_PATH)}`,
      { envs: { GITHUB_TOKEN: token }, timeoutMs: GIT_TIMEOUT_MS },
    );
    const clonedHead = (
      await sandbox.commands.run("git rev-parse HEAD", { cwd: REPO_PATH })
    ).stdout.trim();
    const originalHead = task.originalHead ?? clonedHead;
    if (task.originalHead && clonedHead !== task.originalHead) {
      await sandbox.commands.run(
        `git -c credential.helper= -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} fetch --depth 1 origin ${shellQuote(task.originalHead)} && git checkout --detach ${shellQuote(task.originalHead)}`,
        {
          cwd: REPO_PATH,
          envs: { GITHUB_TOKEN: token },
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
    }
    await sandbox.commands.run(
      `git config user.name ${shellQuote(bot.name)} && git config user.email ${shellQuote(bot.email)}`,
      { cwd: REPO_PATH },
    );
    if (task.patch) {
      config.store.setProgress(
        task.id,
        workerId,
        "preparing",
        "Restoring saved work",
      );
      await restorePatch(sandbox, REPO_PATH, task.patch);
    }

    config.store.checkpoint(task.id, workerId, {
      originalHead,
      baseBranch,
      checkpointJson: task.checkpointJson,
      patch: task.patch,
      report: task.report,
    });
    const resume = task.checkpointJson
      ? (JSON.parse(task.checkpointJson) as AgentProgress)
      : undefined;
    const freeModel = isFreeModel(task.model);
    const client = new OpenRouter({ apiKey: config.openRouterApiKey });
    const modelClient = {
      chat: {
        send: rateLimitedSend(
          async (request: Parameters<typeof client.chat.send>[0]) => {
            const response = await client.chat.send(request, {
              retries: { strategy: "none" },
              timeoutMs: 120_000,
            });
            if (!("choices" in response))
              throw new Error("Expected a non-streaming model response");
            return response;
          },
          {
            minIntervalMs: freeModel ? 3_500 : 0,
            pacer: freeModel ? freePacer : undefined,
            log: config.log,
          },
        ),
      },
    };

    const report = await runAgent(
      {
        sandbox,
        client: modelClient,
        model: task.model,
        repoPath: REPO_PATH,
        maxSteps: task.maxSteps,
        resume,
        log: (message) => config.log?.(`[${task.id}] ${message}`),
        onActivity: async (step, activity) => {
          config.store.setProgress(
            task.id,
            workerId,
            "working",
            activity,
            step,
          );
        },
        pendingInstructions: async () =>
          config.store.pendingInstructions(task.id, workerId).map((item) => ({
            id: item.id,
            text: item.text,
          })),
        reserveFinalization: async (instructionIds) =>
          config.store.reserveFinalization(task.id, workerId, instructionIds),
        onCheckpoint: async (progress) => {
          const patch = await capturePatch(sandbox, REPO_PATH, originalHead);
          config.store.checkpoint(task.id, workerId, {
            originalHead,
            baseBranch,
            checkpointJson: JSON.stringify(progress),
            patch,
            report: progress.finalReport ?? null,
            deliveredInstructionIds: progress.deliveredInstructionIds,
          });
        },
      },
      task.followupCount > 0
        ? `Continue the work on this task using the current repository checkout. Original request: ${task.task}\n\nPrevious result:\n${task.previousReport ?? "No previous report."}\n\nRead and follow the additional instruction in the conversation.`
        : task.task,
      false,
    );

    config.store.setProgress(
      task.id,
      workerId,
      "publishing",
      "Checking changes",
    );

    const latest = config.store.getTask(task.id);
    if (!latest) throw new Error("Task disappeared before publication");
    const patch =
      latest.patch ?? (await capturePatch(sandbox, REPO_PATH, originalHead));
    if (!patch.trim()) {
      config.store.complete(
        task.id,
        workerId,
        report,
        existingPr?.html_url ?? null,
      );
      return;
    }

    if (existingPr && task.branch) {
      if (clonedHead !== originalHead) {
        await sandbox.commands.run("git add -A", { cwd: REPO_PATH });
        const desiredTree = (
          await sandbox.commands.run("git write-tree", { cwd: REPO_PATH })
        ).stdout.trim();
        const remoteTree = (
          await sandbox.commands.run(
            `git rev-parse ${shellQuote(`${clonedHead}^{tree}`)}`,
            { cwd: REPO_PATH },
          )
        ).stdout.trim();
        if (desiredTree !== remoteTree)
          throw new GitHubContinuationError(
            "The pull request branch changed during this task. Review it before submitting a new task.",
          );
        config.store.complete(task.id, workerId, report, existingPr.html_url);
        return;
      }
      await sandbox.commands.run(
        `git add -A && git -c core.hooksPath=/dev/null commit -m ${shellQuote(`cloud-agent follow-up: ${task.task.replaceAll(/\s+/g, " ").slice(0, 55)}`)}`,
        { cwd: REPO_PATH, timeoutMs: GIT_TIMEOUT_MS },
      );
      await sandbox.commands.run(
        `git -c credential.helper= -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} -c core.hooksPath=/dev/null push origin ${shellQuote(task.branch)}`,
        {
          cwd: REPO_PATH,
          envs: { GITHUB_TOKEN: token },
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
      config.store.complete(task.id, workerId, report, existingPr.html_url);
      return;
    }

    const branch = latest.branch ?? branchName();
    if (!latest.branch) config.store.setBranch(task.id, workerId, branch);
    let pr = await findOpenPullRequest(token, owner, name, branch, baseBranch);
    if (!pr) {
      if (!(await remoteBranchExists(token, owner, name, branch))) {
        await sandbox.commands.run(`git switch -c ${shellQuote(branch)}`, {
          cwd: REPO_PATH,
        });
        await sandbox.commands.run(
          `git add -A && git -c core.hooksPath=/dev/null commit -m ${shellQuote(`cloud-agent: ${task.task.replaceAll(/\s+/g, " ").slice(0, 65)}`)}`,
          { cwd: REPO_PATH, timeoutMs: GIT_TIMEOUT_MS },
        );
        await sandbox.commands.run(
          `git remote set-url origin ${shellQuote(cloneUrl)}`,
          { cwd: REPO_PATH },
        );
        await sandbox.commands.run(
          `git -c credential.helper= -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} -c core.hooksPath=/dev/null push -u origin ${shellQuote(branch)}`,
          {
            cwd: REPO_PATH,
            envs: { GITHUB_TOKEN: token },
            timeoutMs: GIT_TIMEOUT_MS,
          },
        );
      }
      pr = await createPullRequest(token, owner, name, {
        title: task.task.replaceAll(/\s+/g, " ").slice(0, 100),
        head: branch,
        base: baseBranch,
        body: `## Task\n\n${task.task}\n\n## Agent report\n\n${report}`,
      });
    }
    config.store.complete(task.id, workerId, report, pr.html_url);
  } finally {
    try {
      await revokeInstallationToken(token);
    } catch (error) {
      config.log?.(
        `Token revocation failed for task ${task.id}: ${String(error)}`,
      );
    }
  }
}

export class WorkerPool {
  private stopping = false;
  private loops: Promise<void>[] = [];
  private active = 0;
  private busy = 0;
  private readonly freePacer = new RequestPacer();
  constructor(private readonly config: WorkerConfig) {}

  start() {
    if (this.loops.length) throw new Error("Worker pool already started");
    for (let index = 0; index < this.config.count; index++)
      this.loops.push(this.workerLoop(index));
  }

  async stop() {
    this.stopping = true;
    await Promise.all(this.loops);
  }

  get warmWorkers() {
    return this.active - this.busy;
  }

  get busyWorkers() {
    return this.busy;
  }

  private async workerLoop(index: number) {
    let sandbox: Sandbox | undefined;
    let workerId = randomUUID();
    let lastRenewal = Date.now();
    while (!this.stopping) {
      try {
        if (!sandbox) {
          sandbox = await Sandbox.create({ timeoutMs: SANDBOX_TIMEOUT_MS });
          workerId = randomUUID();
          lastRenewal = Date.now();
          this.active++;
          this.config.log?.(
            `Worker ${index} warmed sandbox ${sandbox.sandboxId}`,
          );
        }
        this.config.store.requeueExpired();
        const task = this.config.store.claimNext(workerId);
        if (!task) {
          if (Date.now() - lastRenewal > 10 * 60_000) {
            await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
            lastRenewal = Date.now();
          }
          await sleep(1_000);
          continue;
        }
        this.busy++;
        const heartbeat = setInterval(() => {
          try {
            this.config.store.heartbeat(task.id, workerId);
          } catch (error) {
            this.config.log?.(
              `Heartbeat failed for ${task.id}: ${String(error)}`,
            );
          }
        }, 10_000);
        try {
          this.config.log?.(
            `Worker ${index} claimed task ${task.id}, attempt ${task.attempts}`,
          );
          await runTask(this.config, task, workerId, sandbox, this.freePacer);
          this.config.log?.(`Task ${task.id} succeeded`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.config.log?.(`Task ${task.id} failed: ${reason}`);
          try {
            this.config.store.fail(
              task.id,
              workerId,
              reason,
              Date.now(),
              !(
                error instanceof GitHubRepositoryAccessError ||
                error instanceof GitHubContinuationError
              ),
            );
          } catch (storeError) {
            this.config.log?.(
              `Could not requeue ${task.id}: ${String(storeError)}`,
            );
          }
        } finally {
          clearInterval(heartbeat);
          this.busy--;
          await sandbox
            .kill()
            .catch((error) =>
              this.config.log?.(`Sandbox cleanup failed: ${String(error)}`),
            );
          sandbox = undefined;
          this.active--;
        }
      } catch (error) {
        this.config.log?.(`Worker ${index} error: ${String(error)}`);
        if (sandbox) {
          await sandbox.kill().catch(() => {});
          sandbox = undefined;
          this.active--;
        }
        if (!this.stopping) await sleep(5_000);
      }
    }
    if (sandbox) {
      await sandbox.kill().catch(() => {});
      this.active--;
    }
  }
}
