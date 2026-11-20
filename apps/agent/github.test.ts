import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  createPullRequest,
  findOpenPullRequest,
  getDefaultBranch,
  getRepositoryInstallationId,
  GitHubRepositoryAccessError,
  remoteBranchExists,
} from "./github";

test("uses the repository default branch when creating a pull request", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json(
      requests.length === 1
        ? { default_branch: "trunk" }
        : { html_url: "https://github.com/acme/demo/pull/1" },
    );
  }) as typeof fetch;
  try {
    const base = await getDefaultBranch("token", "acme", "demo");
    const pr = await createPullRequest("token", "acme", "demo", {
      title: "Fix build",
      head: "cloud-agent/branch",
      base,
      body: "Report",
    });
    expect(base).toBe("trunk");
    expect(pr.html_url).toBe("https://github.com/acme/demo/pull/1");
    expect(requests[1]?.url).toBe(
      "https://api.github.com/repos/acme/demo/pulls",
    );
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      title: "Fix build",
      head: "cloud-agent/branch",
      base: "trunk",
      body: "Report",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explains a missing repository installation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { message: "Not Found" },
      { status: 404 },
    )) as unknown as typeof fetch;
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = keys.privateKey
      .export({ format: "pem", type: "pkcs1" })
      .toString();
    await expect(
      getRepositoryInstallationId(
        { appId: "1", privateKey },
        "acme",
        "missing",
      ),
    ).rejects.toBeInstanceOf(GitHubRepositoryAccessError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finds the repository installation and an existing PR during retry", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/installation")) return Response.json({ id: 42 });
    if (url.includes("/pulls?"))
      return Response.json([
        { html_url: "https://github.com/acme/demo/pull/2" },
      ]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = keys.privateKey
      .export({ format: "pem", type: "pkcs1" })
      .toString();
    expect(
      await getRepositoryInstallationId(
        { appId: "1", privateKey },
        "acme",
        "demo",
      ),
    ).toBe("42");
    expect(
      (
        await findOpenPullRequest(
          "token",
          "acme",
          "demo",
          "cloud-agent/one",
          "main",
        )
      )?.html_url,
    ).toBe("https://github.com/acme/demo/pull/2");
    expect(
      await remoteBranchExists("token", "acme", "demo", "cloud-agent/one"),
    ).toBe(false);
    expect(urls[1]).toContain("head=acme%3Acloud-agent%2Fone");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
