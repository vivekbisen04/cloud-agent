import { resolve, sep } from "node:path";
import type {
  ChatFunctionTool,
  ChatMessages,
  ChatResult,
  ChatToolCall,
} from "@openrouter/sdk/models";
import type { Sandbox } from "e2b";
import { CommandExitError } from "e2b";

const OUTPUT_LIMIT = 16_000;
const TOOL_TIMEOUT_MS = 60_000;
const CONTEXT_LIMIT = 80_000;

const baseTools: ChatFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the cloned repository. Returns exit code, stdout, and stderr. Commands time out after 60 seconds.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file in the cloned repository.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

const subAgentTool: ChatFunctionTool = {
  type: "function",
  function: {
    name: "sub_agent",
    description:
      "Investigate a self-contained question about the repository and return findings. The sub-agent can read files and run commands.",
    parameters: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    },
  },
};

export type ModelClient = {
  chat: {
    send: (request: {
      chatRequest: {
        model: string;
        messages: ChatMessages[];
        tools?: ChatFunctionTool[];
        stream: false;
      };
    }) => Promise<ChatResult>;
  };
};

export type AgentProgress = {
  messages: ChatMessages[];
  completedSteps: number;
  finalReport?: string;
  deliveredInstructionIds?: string[];
};

export type AgentContext = {
  sandbox: Pick<Sandbox, "commands" | "files">;
  client: ModelClient;
  model: string;
  repoPath: string;
  maxSteps: number;
  log?: (message: string) => void;
  resume?: AgentProgress;
  onCheckpoint?: (progress: AgentProgress) => Promise<void>;
  onActivity?: (step: number, activity: string) => Promise<void>;
  pendingInstructions?: () => Promise<{ id: string; text: string }[]>;
  reserveFinalization?: (
    instructionIdsBeingDelivered: string[],
  ) => Promise<boolean>;
};

function truncate(value: string) {
  return value.length > OUTPUT_LIMIT
    ? `${value.slice(0, OUTPUT_LIMIT)}\n[output truncated]`
    : value;
}

async function responseFor(
  call: ChatToolCall,
  context: AgentContext,
  allowSubAgent: boolean,
): Promise<ChatMessages> {
  let result: unknown;
  try {
    const args: unknown = JSON.parse(call.function.arguments);
    if (!args || typeof args !== "object")
      throw new Error("Tool arguments must be an object");
    const input = args as Record<string, unknown>;
    if (call.function.name === "bash") {
      if (
        typeof input.command !== "string" ||
        !input.command.trim() ||
        input.command.length > 10_000
      )
        throw new Error("Invalid command");
      context.log?.(`$ ${input.command}`);
      try {
        const run = await context.sandbox.commands.run(input.command, {
          cwd: context.repoPath,
          timeoutMs: TOOL_TIMEOUT_MS,
        });
        result = {
          exitCode: run.exitCode,
          stdout: truncate(run.stdout),
          stderr: truncate(run.stderr),
        };
      } catch (error) {
        if (!(error instanceof CommandExitError)) throw error;
        result = {
          exitCode: error.exitCode,
          stdout: truncate(error.stdout),
          stderr: truncate(error.stderr),
        };
      }
    } else if (call.function.name === "read_file") {
      if (typeof input.path !== "string" || !input.path.trim())
        throw new Error("Invalid path");
      const absolute = resolve(context.repoPath, input.path);
      if (
        absolute !== context.repoPath &&
        !absolute.startsWith(`${context.repoPath}${sep}`)
      )
        throw new Error("Path is outside the repository");
      result = {
        content: truncate(await context.sandbox.files.read(absolute)),
      };
    } else if (call.function.name === "sub_agent" && allowSubAgent) {
      if (
        typeof input.task !== "string" ||
        !input.task.trim() ||
        input.task.length > 5_000
      )
        throw new Error("Invalid sub-agent task");
      result = {
        report: await runAgent(
          { ...context, resume: undefined, onCheckpoint: undefined },
          input.task,
          false,
          Math.min(10, context.maxSteps),
        ),
      };
    } else {
      throw new Error(`Unknown tool: ${call.function.name}`);
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  return { role: "tool", toolCallId: call.id, content: JSON.stringify(result) };
}

async function compact(messages: ChatMessages[], context: AgentContext) {
  const history = messages.slice(2);
  if (!history.length) return;
  const result = await context.client.chat.send({
    chatRequest: {
      model: context.model,
      messages: [
        {
          role: "system",
          content:
            "Summarize this coding agent history accurately. Include changed files, commands and results, unresolved issues, and next steps. Do not invent facts.",
        },
        { role: "user", content: JSON.stringify(history) },
      ],
      stream: false,
    },
  });
  const summary = result.choices[0]?.message.content;
  if (typeof summary !== "string" || !summary)
    throw new Error("Could not compact agent history");
  messages.splice(2, history.length, {
    role: "user",
    content: `Progress summary:\n${summary}\nContinue the original task.`,
  });
}

export async function runAgent(
  context: AgentContext,
  task: string,
  allowSubAgent = true,
  maxSteps = context.maxSteps,
): Promise<string> {
  const messages: ChatMessages[] = context.resume?.messages ?? [
    {
      role: "system",
      content: `You are a coding agent in an isolated sandbox. The repository is at ${context.repoPath}. Inspect it, implement the requested change, and run relevant checks. Do not create commits, push branches, open pull requests, or print secrets; the host handles GitHub publication. ${allowSubAgent ? "You may use the sub_agent tool for focused investigations." : ""} Finish with a concise account of changes and checks.`,
    },
    { role: "user", content: task },
  ];
  const tools = allowSubAgent ? [...baseTools, subAgentTool] : baseTools;
  if (context.resume?.finalReport) return context.resume.finalReport;
  let instructionsToDeliver: string[] = [];
  const addInstructions = async () => {
    const incoming = (await context.pendingInstructions?.()) ?? [];
    let added = 0;
    for (const instruction of incoming) {
      if (instructionsToDeliver.includes(instruction.id)) continue;
      messages.push({
        role: "user",
        content: `Additional instruction: ${instruction.text}`,
      });
      instructionsToDeliver.push(instruction.id);
      added++;
    }
    return added;
  };
  const checkpoint = async (progress: AgentProgress) => {
    await context.onCheckpoint?.({
      ...progress,
      deliveredInstructionIds: instructionsToDeliver,
    });
    instructionsToDeliver = [];
  };
  for (
    let step = (context.resume?.completedSteps ?? 0) + 1;
    step <= maxSteps;
    step++
  ) {
    await addInstructions();
    await context.onActivity?.(step, "Thinking through next change");
    context.log?.(`Agent step ${step}/${maxSteps}`);
    const response = await context.client.chat.send({
      chatRequest: { model: context.model, messages, tools, stream: false },
    });
    const choice = response.choices[0];
    if (!choice) throw new Error("Model returned no choices");
    messages.push(choice.message);
    const calls = choice.message.toolCalls ?? [];
    if (!calls.length) {
      if (
        typeof choice.message.content !== "string" ||
        !choice.message.content.trim()
      )
        throw new Error("Model returned no answer");
      // A message sent while the model was responding must be seen before we finish.
      if (await addInstructions()) {
        await checkpoint({ messages, completedSteps: step });
        continue;
      }
      if (
        context.reserveFinalization &&
        !(await context.reserveFinalization(instructionsToDeliver))
      ) {
        await addInstructions();
        await checkpoint({ messages, completedSteps: step });
        continue;
      }
      await checkpoint({
        messages,
        completedSteps: step,
        finalReport: choice.message.content,
      });
      return choice.message.content;
    }
    for (const call of calls) {
      await context.onActivity?.(
        step,
        call.function.name === "bash"
          ? "Running a command"
          : call.function.name === "read_file"
            ? "Reading a file"
            : "Investigating repository",
      );
      messages.push(await responseFor(call, context, allowSubAgent));
    }
    if ((response.usage?.promptTokens ?? 0) > CONTEXT_LIMIT)
      await compact(messages, context);
    await checkpoint({ messages, completedSteps: step });
  }
  throw new Error(`Agent reached the ${maxSteps}-step limit before finishing`);
}
