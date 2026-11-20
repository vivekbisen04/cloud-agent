import { OpenRouter } from "@openrouter/sdk";
import { Sandbox } from "e2b";
import { runAgent } from "./agent";
import { branchName, HELP, parseArgs, shellQuote } from "./cli";
import { isFreeModel, rateLimitedSend } from "./model-client";
import {
  createInstallationToken,
  createPullRequest,
  getDefaultBranch,
  getAppBotIdentity,
  revokeInstallationToken,
} from "./github";

const REPO_PATH = "/home/user/repo";
const SANDBOX_TIMEOUT_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 120_000;
const CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Set ${name} in apps/agent/.env or the process environment`,
    );
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.log(HELP);
    return;
  }

  const apiKey = requiredEnv("OPENROUTER_API_KEY");
  requiredEnv("E2B_API_KEY");
  const appId = requiredEnv("GITHUB_APP_ID");
  const installationId = requiredEnv("GITHUB_INSTALLATION_ID");
  const privateKeyPath = requiredEnv("GITHUB_APP_PRIVATE_KEY_PATH");
  const privateKey = await Bun.file(privateKeyPath).text();
  const appConfig = { appId, privateKey };
  const client = new OpenRouter({ apiKey });
  let token: string | undefined;
  let sandbox: Sandbox | undefined;
  let failure: unknown;

  try {
    console.log(`Starting task for ${options.owner}/${options.repo}...`);
    token = (
      await createInstallationToken(appConfig, installationId, options.repo)
    ).token;
    const bot = await getAppBotIdentity(appConfig, token);
    const base = await getDefaultBranch(token, options.owner, options.repo);
    sandbox = await Sandbox.create({ timeoutMs: SANDBOX_TIMEOUT_MS });
    console.log(`Sandbox: ${sandbox.sandboxId}`);

    // The credential helper reads the token only for the clone/push commands.
    // Agent tool commands do not receive GITHUB_TOKEN.
    await sandbox.commands.run(
      `git -c credential.helper= -c credential.helper=${shellQuote(CREDENTIAL_HELPER)} clone --depth 1 ${shellQuote(`https://github.com/${options.owner}/${options.repo}.git`)} ${shellQuote(REPO_PATH)}`,
      {
        envs: { GITHUB_TOKEN: token },
        timeoutMs: GIT_TIMEOUT_MS,
      },
    );
    const originalHead = (
      await sandbox.commands.run("git rev-parse HEAD", { cwd: REPO_PATH })
    ).stdout.trim();
    await sandbox.commands.run(
      `git config user.name ${shellQuote(bot.name)} && git config user.email ${shellQuote(bot.email)}`,
      { cwd: REPO_PATH },
    );

    const freeModel = isFreeModel(options.model);
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
            log: (message) => console.log(message),
          },
        ),
      },
    };
    const report = await runAgent(
      {
        sandbox,
        client: modelClient,
        model: options.model,
        repoPath: REPO_PATH,
        maxSteps: options.maxSteps,
        log: (message) => console.log(message),
      },
      options.task,
      !freeModel,
    );
    console.log(`Agent report:\n${report}`);

    const status = await sandbox.commands.run("git status --porcelain", {
      cwd: REPO_PATH,
    });
    const currentHead = (
      await sandbox.commands.run("git rev-parse HEAD", { cwd: REPO_PATH })
    ).stdout.trim();
    if (!status.stdout.trim() && currentHead === originalHead) {
      console.log("No file changes; no pull request created.");
    } else {
      const branch = branchName();
      await sandbox.commands.run(`git switch -c ${shellQuote(branch)}`, {
        cwd: REPO_PATH,
      });
      if (status.stdout.trim()) {
        await sandbox.commands.run(
          `git add -A && git -c core.hooksPath=/dev/null commit -m ${shellQuote(`cloud-agent: ${options.task.replaceAll(/\s+/g, " ").slice(0, 65)}`)}`,
          {
            cwd: REPO_PATH,
            timeoutMs: GIT_TIMEOUT_MS,
          },
        );
      }
      await sandbox.commands.run(
        `git remote set-url origin ${shellQuote(`https://github.com/${options.owner}/${options.repo}.git`)}`,
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

      console.log(`Pushed branch: ${branch}`);
      const title = options.task.replaceAll(/\s+/g, " ").slice(0, 100);
      const pr = await createPullRequest(token, options.owner, options.repo, {
        title,
        head: branch,
        base,
        body: `## Task\n\n${options.task}\n\n## Agent report\n\n${report}`,
      });
      console.log(`Pull request: ${pr.html_url}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch (error) {
        console.error("Sandbox cleanup failed:", error);
        failure ??= error;
      }
    }
    if (token) {
      try {
        await revokeInstallationToken(token);
      } catch (error) {
        console.error("Token revocation failed:", error);
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
