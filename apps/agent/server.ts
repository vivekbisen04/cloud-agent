import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "./cli";
import { TaskStore, publicTask } from "./store";
import { WorkerPool } from "./workers";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bearer(request: Request): string {
  const match = /^Bearer (\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new HttpError(401, "Bearer token required");
  return match[1]!;
}

function matchesSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 20_000)
    throw new HttpError(413, "Request body is too large");
  const text = await request.text();
  if (text.length > 20_000)
    throw new HttpError(413, "Request body is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

function repository(value: unknown): string {
  if (typeof value !== "string")
    throw new HttpError(400, "Repository must be owner/name");
  try {
    const parsed = parseArgs(["--repo", value, "--task", "validate"])!;
    return `${parsed.owner}/${parsed.repo}`;
  } catch {
    throw new HttpError(400, "Repository must be owner/name");
  }
}

function taskInput(body: Record<string, unknown>) {
  const repo = repository(body.repo);
  if (typeof body.task !== "string")
    throw new HttpError(400, "Task must be text");
  if (body.model !== undefined && typeof body.model !== "string")
    throw new HttpError(400, "Model must be text");
  if (body.maxSteps !== undefined && typeof body.maxSteps !== "number")
    throw new HttpError(400, "maxSteps must be a number");
  try {
    return parseArgs([
      "--repo",
      repo,
      "--task",
      body.task,
      "--model",
      body.model ?? "openrouter/free",
      "--max-steps",
      String(body.maxSteps ?? 25),
    ])!;
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid task",
    );
  }
}

export function createApiHandler(
  store: TaskStore,
  adminKey: string,
  warmWorkers: () => number = () => 0,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const pathname = new URL(request.url).pathname;
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/styles.css": ["styles.css", "text/css; charset=utf-8"],
        "/favicon.svg": ["favicon.svg", "image/svg+xml"],
      };
      const asset = assets[pathname];
      if (request.method === "GET" && asset) {
        return new Response(
          Bun.file(new URL(`./public/${asset[0]}`, import.meta.url)),
          {
            headers: {
              "content-type": asset[1],
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
              "x-content-type-options": "nosniff",
            },
          },
        );
      }
      if (request.method === "GET" && pathname === "/health") {
        return Response.json({ ok: true, warmWorkers: warmWorkers() });
      }
      if (pathname === "/v1/admin/users" && request.method === "GET") {
        if (!matchesSecret(bearer(request), adminKey))
          throw new HttpError(403, "Admin key required");
        return Response.json(store.listUsers());
      }
      if (pathname === "/v1/admin/tasks" && request.method === "GET") {
        if (!matchesSecret(bearer(request), adminKey))
          throw new HttpError(403, "Admin key required");
        return Response.json(
          store.listAllTasks().map((task) => ({
            ...publicTask(task),
            userId: task.userId,
            userName: task.userName,
          })),
        );
      }
      if (pathname === "/v1/admin/users" && request.method === "POST") {
        if (!matchesSecret(bearer(request), adminKey))
          throw new HttpError(403, "Admin key required");
        const body = await jsonBody(request);
        if (
          typeof body.name !== "string" ||
          !body.name.trim() ||
          body.name.length > 100
        )
          throw new HttpError(400, "Name must be 1-100 characters");
        if (
          !Array.isArray(body.repos) ||
          !body.repos.length ||
          body.repos.length > 100
        )
          throw new HttpError(400, "Provide 1-100 allowed repositories");
        const repos = body.repos.map(repository);
        const created = store.createUser(body.name.trim(), repos);
        return Response.json(
          {
            id: created.user.id,
            name: created.user.name,
            apiKey: created.apiKey,
            repos,
          },
          { status: 201 },
        );
      }
      const adminRepo = /^\/v1\/admin\/users\/([0-9a-f-]+)\/repos$/.exec(
        pathname,
      );
      if (adminRepo && request.method === "POST") {
        if (!matchesSecret(bearer(request), adminKey))
          throw new HttpError(403, "Admin key required");
        const body = await jsonBody(request);
        const repo = repository(body.repo);
        if (!store.addRepo(adminRepo[1]!, repo))
          throw new HttpError(404, "User not found");
        return Response.json({ repo }, { status: 201 });
      }
      if (pathname.startsWith("/v1/")) {
        const user = store.userForKey(bearer(request));
        if (!user) throw new HttpError(401, "Invalid user key");
        if (pathname === "/v1/me" && request.method === "GET") {
          return Response.json({
            id: user.id,
            name: user.name,
            repos: store.allowedRepos(user.id),
          });
        }
        if (pathname === "/v1/tasks" && request.method === "POST") {
          const input = taskInput(await jsonBody(request));
          let task;
          try {
            task = store.enqueue(user.id, {
              repo: `${input.owner}/${input.repo}`,
              task: input.task,
              model: input.model,
              maxSteps: input.maxSteps,
            });
          } catch (error) {
            throw new HttpError(
              403,
              error instanceof Error
                ? error.message
                : "Repository is not allowed",
            );
          }
          return Response.json(publicTask(task), { status: 202 });
        }
        if (pathname === "/v1/tasks" && request.method === "GET") {
          return Response.json(store.listTasks(user.id).map(publicTask));
        }
        const continueRoute = /^\/v1\/tasks\/([0-9a-f-]+)\/continue$/.exec(
          pathname,
        );
        if (continueRoute && request.method === "POST") {
          const task = store.getTaskForUser(continueRoute[1]!, user.id);
          if (!task) throw new HttpError(404, "Task not found");
          const body = await jsonBody(request);
          if (
            typeof body.text !== "string" ||
            !body.text.trim() ||
            body.text.length > 4000
          )
            throw new HttpError(400, "Instruction must be 1-4000 characters");
          try {
            const continued = store.continueTask(
              task.id,
              user.id,
              body.text.trim(),
            );
            return Response.json(publicTask(continued!), { status: 202 });
          } catch (error) {
            throw new HttpError(
              409,
              error instanceof Error
                ? error.message
                : "Task cannot be continued",
            );
          }
        }
        const instructionRoute =
          /^\/v1\/tasks\/([0-9a-f-]+)\/instructions$/.exec(pathname);
        if (instructionRoute) {
          const task = store.getTaskForUser(instructionRoute[1]!, user.id);
          if (!task) throw new HttpError(404, "Task not found");
          if (request.method === "GET")
            return Response.json(store.listInstructions(task.id));
          if (request.method === "POST") {
            const body = await jsonBody(request);
            if (
              typeof body.text !== "string" ||
              !body.text.trim() ||
              body.text.length > 4000
            )
              throw new HttpError(400, "Instruction must be 1-4000 characters");
            try {
              const instruction = store.addInstruction(
                task.id,
                user.id,
                body.text.trim(),
              );
              return Response.json(instruction, { status: 201 });
            } catch (error) {
              throw new HttpError(
                409,
                error instanceof Error ? error.message : "Task is not active",
              );
            }
          }
        }
        const taskRoute = /^\/v1\/tasks\/([0-9a-f-]+)$/.exec(pathname);
        if (taskRoute && request.method === "GET") {
          const task = store.getTaskForUser(taskRoute[1]!, user.id);
          if (!task) throw new HttpError(404, "Task not found");
          return Response.json(publicTask(task));
        }
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : "Internal server error";
      if (status === 500) console.error(error);
      return Response.json({ error: message }, { status });
    }
  };
}

if (import.meta.main) {
  const adminKey = process.env.CLOUD_AGENT_ADMIN_KEY;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!adminKey || adminKey.length < 32)
    throw new Error(
      "Set CLOUD_AGENT_ADMIN_KEY to a random value of at least 32 characters",
    );
  if (
    !openRouterApiKey ||
    !process.env.E2B_API_KEY ||
    !appId ||
    !privateKeyPath
  ) {
    throw new Error(
      "Set OPENROUTER_API_KEY, E2B_API_KEY, GITHUB_APP_ID, and GITHUB_APP_PRIVATE_KEY_PATH",
    );
  }
  const count = Number(process.env.CLOUD_AGENT_WORKERS ?? "2");
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw new Error("CLOUD_AGENT_WORKERS must be 1-8");
  const port = Number(process.env.CLOUD_AGENT_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CLOUD_AGENT_PORT must be a valid port");
  const dbPath = resolve(
    process.env.CLOUD_AGENT_DB_PATH ?? "data/tasks.sqlite",
  );
  const store = new TaskStore(dbPath);
  const app = { appId, privateKey: await Bun.file(privateKeyPath).text() };
  const pool = new WorkerPool({
    store,
    app,
    openRouterApiKey,
    count,
    log: console.log,
  });
  pool.start();
  const server = Bun.serve({
    hostname: process.env.CLOUD_AGENT_HOST ?? "127.0.0.1",
    port,
    fetch: createApiHandler(store, adminKey, () => pool.warmWorkers),
  });
  console.log(`Cloud Agent API listening at ${server.url}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await pool.stop();
    store.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
