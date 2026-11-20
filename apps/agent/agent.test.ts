import { expect, test } from "bun:test";
import type { ChatResult } from "@openrouter/sdk/models";
import type { AgentContext } from "./agent";
import { runAgent } from "./agent";

function reply(message: ChatResult["choices"][number]["message"]): ChatResult {
  return { choices: [{ message }] } as ChatResult;
}

test("returns a tool failure to the model and continues to a final answer", async () => {
  const requests: unknown[] = [];
  const responses = [
    reply({
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"../secret"}' },
        },
      ],
    }),
    reply({ role: "assistant", content: "Finished the requested change." }),
  ];
  const context = {
    sandbox: {
      commands: {
        run: async () => {
          throw new Error("Unexpected command");
        },
      },
      files: {
        read: async () => {
          throw new Error("Unexpected read");
        },
      },
    },
    client: {
      chat: {
        send: async (request: unknown) => {
          requests.push(request);
          return responses.shift()!;
        },
      },
    },
    model: "test/model",
    repoPath: "/home/user/repo",
    maxSteps: 3,
  } as unknown as AgentContext;
  expect(await runAgent(context, "Fix it")).toBe(
    "Finished the requested change.",
  );
  expect(JSON.stringify(requests[1])).toContain(
    "Path is outside the repository",
  );
});

test("fails clearly when the model never finishes", async () => {
  const context = {
    sandbox: {
      commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: { read: async () => "" },
    },
    client: {
      chat: {
        send: async () =>
          reply({
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: crypto.randomUUID(),
                type: "function",
                function: { name: "bash", arguments: '{"command":"true"}' },
              },
            ],
          }),
      },
    },
    model: "test/model",
    repoPath: "/home/user/repo",
    maxSteps: 2,
  } as unknown as AgentContext;
  expect(runAgent(context, "Fix it")).rejects.toThrow("2-step limit");
});

test("resumes after a saved tool turn without replaying that turn", async () => {
  let checkpoint: import("./agent").AgentProgress | undefined;
  let toolRuns = 0;
  const first = {
    sandbox: {
      commands: {
        run: async () => {
          toolRuns++;
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
      files: { read: async () => "" },
    },
    client: {
      chat: {
        send: async () =>
          reply({
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "one",
                type: "function",
                function: { name: "bash", arguments: '{"command":"echo ok"}' },
              },
            ],
          }),
      },
    },
    model: "test/model",
    repoPath: "/home/user/repo",
    maxSteps: 1,
    onCheckpoint: async (progress: import("./agent").AgentProgress) => {
      checkpoint = structuredClone(progress);
    },
  } as unknown as AgentContext;
  await expect(runAgent(first, "Fix it")).rejects.toThrow("step limit");
  expect(checkpoint?.completedSteps).toBe(1);
  const second = {
    ...first,
    maxSteps: 2,
    resume: checkpoint,
    client: {
      chat: { send: async () => reply({ role: "assistant", content: "Done" }) },
    },
  } as AgentContext;
  expect(await runAgent(second, "Fix it")).toBe("Done");
  expect(toolRuns).toBe(1);
});

test("adds a queued instruction before the next model step", async () => {
  const requests: unknown[] = [];
  const checkpoints: import("./agent").AgentProgress[] = [];
  const context = {
    sandbox: {
      commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: { read: async () => "" },
    },
    client: {
      chat: {
        send: async (request: unknown) => {
          requests.push(request);
          return reply({ role: "assistant", content: "Added the examples." });
        },
      },
    },
    model: "test/model",
    repoPath: "/home/user/repo",
    maxSteps: 2,
    pendingInstructions: async () => [
      { id: "instruction-1", text: "Add examples" },
    ],
    reserveFinalization: async () => true,
    onCheckpoint: async (progress: import("./agent").AgentProgress) => {
      checkpoints.push(progress);
    },
  } as unknown as AgentContext;
  expect(await runAgent(context, "Edit README", false)).toBe(
    "Added the examples.",
  );
  expect(JSON.stringify(requests[0])).toContain(
    "Additional instruction: Add examples",
  );
  expect(checkpoints[0]?.deliveredInstructionIds).toEqual(["instruction-1"]);
});

test("finishing response waits for an instruction that arrived during the model call", async () => {
  let polls = 0;
  let calls = 0;
  const context = {
    sandbox: {
      commands: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      files: { read: async () => "" },
    },
    client: {
      chat: {
        send: async () => {
          calls++;
          return reply({
            role: "assistant",
            content:
              calls === 1 ? "Initial answer" : "Answer with extra guidance",
          });
        },
      },
    },
    model: "test/model",
    repoPath: "/home/user/repo",
    maxSteps: 3,
    pendingInstructions: async () => {
      polls++;
      return polls === 1 ? [] : [{ id: "late", text: "Add setup notes" }];
    },
    reserveFinalization: async () => true,
    onCheckpoint: async () => {},
  } as unknown as AgentContext;
  expect(await runAgent(context, "Edit README", false)).toBe(
    "Answer with extra guidance",
  );
  expect(calls).toBe(2);
});
