import { expect, test } from "bun:test";
import { createApiHandler } from "./server";
import { TaskStore } from "./store";

test("API authenticates users and scopes task reads and writes", async () => {
  const store = new TaskStore(":memory:");
  const handle = createApiHandler(store, "a".repeat(40), () => 2);
  const request = (
    path: string,
    method: string,
    token: string,
    body?: unknown,
  ) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    expect((await handle(new Request("http://localhost/health"))).status).toBe(
      200,
    );
    const home = await handle(new Request("http://localhost/"));
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(home.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(await home.text()).toContain("Connect to your workspace");
    const admin = "a".repeat(40);
    const aliceResponse = await request("/v1/admin/users", "POST", admin, {
      name: "Alice",
      repos: ["alice/project"],
    });
    expect(aliceResponse.status).toBe(201);
    const alice = (await aliceResponse.json()) as { apiKey: string };
    const bob = (await (
      await request("/v1/admin/users", "POST", admin, {
        name: "Bob",
        repos: ["bob/project"],
      })
    ).json()) as { apiKey: string };
    const created = await request("/v1/tasks", "POST", alice.apiKey, {
      repo: "alice/project",
      task: "Improve README",
    });
    expect(created.status).toBe(202);
    const task = (await created.json()) as { id: string };
    const instruction = await request(
      `/v1/tasks/${task.id}/instructions`,
      "POST",
      alice.apiKey,
      { text: "Also check the setup steps." },
    );
    expect(instruction.status).toBe(201);
    expect(
      (await request(`/v1/tasks/${task.id}/instructions`, "GET", bob.apiKey))
        .status,
    ).toBe(404);
    expect(
      (await request(`/v1/tasks/${task.id}/instructions`, "GET", alice.apiKey))
        .status,
    ).toBe(200);
    const usersResponse = await request("/v1/admin/users", "GET", admin);
    expect(usersResponse.status).toBe(200);
    const users = (await usersResponse.json()) as {
      name: string;
      repos: string[];
    }[];
    expect(users).toHaveLength(2);
    expect(users.find((user) => user.name === "Alice")?.repos).toContain(
      "alice/project",
    );
    const allTasks = await request("/v1/admin/tasks", "GET", admin);
    expect(allTasks.status).toBe(200);
    expect(
      ((await allTasks.json()) as { userName: string }[])[0]?.userName,
    ).toBe("Alice");
    expect((await request("/v1/admin/tasks", "GET", bob.apiKey)).status).toBe(
      403,
    );
    expect(
      (await request(`/v1/tasks/${task.id}`, "GET", bob.apiKey)).status,
    ).toBe(404);
    expect(
      (
        await request("/v1/tasks", "POST", bob.apiKey, {
          repo: "alice/project",
          task: "Change it",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(`/v1/tasks/${task.id}`, "GET", alice.apiKey)).status,
    ).toBe(200);
    const taskState = (await (
      await request(`/v1/tasks/${task.id}`, "GET", alice.apiKey)
    ).json()) as { completedSteps: number; phase: string };
    expect(taskState.completedSteps).toBe(0);
    expect(taskState.phase).toBe("queued");
  } finally {
    store.close();
  }
});

test("task owner can continue a completed task through the API", async () => {
  const store = new TaskStore(":memory:");
  const handle = createApiHandler(store, "a".repeat(40));
  const request = (
    path: string,
    method: string,
    token: string,
    body?: unknown,
  ) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    const alice = store.createUser("Alice", ["alice/project"]);
    const bob = store.createUser("Bob", ["bob/project"]);
    const task = store.enqueue(alice.user.id, {
      repo: "alice/project",
      task: "Improve README",
      model: "openrouter/free",
      maxSteps: 10,
    });
    store.claimNext("worker-a");
    store.complete(task.id, "worker-a", "Initial report", null);
    const path = `/v1/tasks/${task.id}/continue`;
    expect(
      (await request(path, "POST", bob.apiKey, { text: "Next" })).status,
    ).toBe(404);
    const response = await request(path, "POST", alice.apiKey, {
      text: "Add examples",
    });
    expect(response.status).toBe(202);
    const continued = (await response.json()) as {
      id: string;
      status: string;
      previousReport: string;
    };
    expect(continued.id).toBe(task.id);
    expect(continued.status).toBe("queued");
    expect(continued.previousReport).toBe("Initial report");
    expect(
      (await request(path, "POST", alice.apiKey, { text: "Again" })).status,
    ).toBe(409);
  } finally {
    store.close();
  }
});
