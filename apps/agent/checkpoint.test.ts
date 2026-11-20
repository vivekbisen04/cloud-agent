import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "e2b";
import { capturePatch, restorePatch } from "./checkpoint";

test("a Git patch restores edited and new files after a worker failure", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "cloud-agent-checkpoint-"));
  const run = async (command: string, options: { cwd?: string } = {}) => {
    const child = Bun.spawn(["bash", "-lc", command], {
      cwd: options.cwd ?? repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0)
      throw new Error(`Command failed: ${command}: ${stderr}`);
    return { exitCode, stdout, stderr };
  };
  const workspace = {
    commands: { run },
    files: {
      read: (path: string) => Bun.file(path).text(),
      write: (path: string, value: string) => Bun.write(path, value),
    },
  } as unknown as Pick<Sandbox, "commands" | "files">;
  try {
    await run(
      "git init -b main && git config user.name Test && git config user.email test@example.com",
    );
    await Bun.write(join(repoPath, "README.md"), "original\n");
    await run("git add -A && git commit -m initial");
    const head = (await run("git rev-parse HEAD")).stdout.trim();
    await Bun.write(join(repoPath, "README.md"), "improved\n");
    await Bun.write(join(repoPath, "new.txt"), "new file\n");
    const patch = await capturePatch(workspace, repoPath, head);
    expect(patch).toContain("README.md");
    expect(patch).toContain("new.txt");
    await run("git reset --hard HEAD && git clean -fd");
    await restorePatch(workspace, repoPath, patch);
    expect(await Bun.file(join(repoPath, "README.md")).text()).toBe(
      "improved\n",
    );
    expect(await Bun.file(join(repoPath, "new.txt")).text()).toBe("new file\n");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
