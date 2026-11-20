export type CliOptions = {
  owner: string;
  repo: string;
  task: string;
  model: string;
  maxSteps: number;
};

export const HELP = `Usage: bun run start --repo owner/name --task "Describe the change"

Options:
  --repo       GitHub repository installed for your GitHub App
  --task       Coding task for the agent
  --model      OpenRouter model (default: google/gemini-3-flash-preview)
  --max-steps  Maximum model turns, 1-50 (default: 25)
  --help       Show this help`;

export function parseArgs(args: string[]): CliOptions | null {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return null;
    if (!arg || !["--repo", "--task", "--model", "--max-steps"].includes(arg)) {
      throw new Error(`Unknown option: ${arg ?? ""}\n${HELP}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--") || values.has(arg))
      throw new Error(`Missing or duplicate value for ${arg}`);
    values.set(arg, value);
  }

  const repository = values.get("--repo") ?? "";
  const match =
    /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(
      repository,
    );
  if (
    !match ||
    match[2] === "." ||
    match[2] === ".." ||
    match[2]?.endsWith(".git")
  ) {
    throw new Error("Use --repo owner/name (without a URL or .git suffix)");
  }
  const task = values.get("--task")?.trim();
  if (!task || task.length > 10_000)
    throw new Error("Provide --task with 1-10000 characters");
  const steps = Number(values.get("--max-steps") ?? "25");
  if (!Number.isInteger(steps) || steps < 1 || steps > 50)
    throw new Error("--max-steps must be an integer from 1 to 50");
  const model = values.get("--model") ?? "google/gemini-3-flash-preview";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,150}$/.test(model))
    throw new Error("Invalid --model value");

  return { owner: match[1]!, repo: match[2]!, task, model, maxSteps: steps };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function branchName(
  now = new Date(),
  random: string = crypto.randomUUID(),
): string {
  return `cloud-agent/${now.toISOString().replaceAll(/[-:.]/g, "").slice(0, 15)}-${random.slice(0, 8)}`;
}
