import type { Sandbox } from "e2b";
import { shellQuote } from "./cli";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const PATCH_PATH = "/tmp/cloud-agent-checkpoint.patch";

type Workspace = Pick<Sandbox, "commands" | "files">;

export async function capturePatch(
  workspace: Workspace,
  repoPath: string,
  originalHead: string,
): Promise<string> {
  await workspace.commands.run(
    `git add -A && git diff --cached --binary ${shellQuote(originalHead)} > ${PATCH_PATH}`,
    { cwd: repoPath, timeoutMs: 120_000 },
  );
  const patch = await workspace.files.read(PATCH_PATH);
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES)
    throw new Error("Checkpoint patch exceeds 2 MB");
  return patch;
}

export async function restorePatch(
  workspace: Workspace,
  repoPath: string,
  patch: string,
): Promise<void> {
  if (!patch) return;
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES)
    throw new Error("Checkpoint patch exceeds 2 MB");
  await workspace.files.write(PATCH_PATH, patch);
  await workspace.commands.run(`git apply --index ${PATCH_PATH}`, {
    cwd: repoPath,
    timeoutMs: 120_000,
  });
}
