import { createPrivateKey, sign } from "node:crypto";

const GITHUB_API = "https://api.github.com";

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class GitHubRepositoryAccessError extends Error {}

export type GitHubAppConfig = {
  appId: string;
  // PEM contents of the private key downloaded from the GitHub App settings page
  privateKey: string;
};

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

// A short-lived (max 10 min) JWT that authenticates as the GitHub App itself.
// It can only be used to mint installation tokens, not to touch repos.
function createAppJwt({ appId, privateKey }: GitHubAppConfig) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated to tolerate clock drift between us and GitHub
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
  );
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPrivateKey(privateKey),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

async function githubRequest<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      `GitHub ${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`,
    );
  }

  return (response.status === 204 ? undefined : await response.json()) as T;
}

export type InstallationToken = {
  token: string;
  expiresAt: string;
};

// Mints a 1-hour installation token scoped to a single repo with only the
// permissions the agent needs to push a branch and open a PR.
export async function createInstallationToken(
  config: GitHubAppConfig,
  installationId: string,
  repo: string,
): Promise<InstallationToken> {
  const result = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    createAppJwt(config),
    {
      method: "POST",
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );

  return { token: result.token, expiresAt: result.expires_at };
}

export async function revokeInstallationToken(token: string) {
  await githubRequest<void>("/installation/token", token, { method: "DELETE" });
}

// The "<slug>[bot]" identity, so commits made by the agent are attributed to the app.
// The app JWT only works on /app endpoints, so the user lookup uses the installation token.
export async function getAppBotIdentity(
  config: GitHubAppConfig,
  installationToken: string,
) {
  const app = await githubRequest<{ slug: string }>(
    "/app",
    createAppJwt(config),
  );
  const login = `${app.slug}[bot]`;
  const user = await githubRequest<{ id: number }>(
    `/users/${encodeURIComponent(login)}`,
    installationToken,
  );
  return { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
}

export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<string> {
  const result = await githubRequest<{ default_branch: string }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token,
  );
  return result.default_branch;
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  input: { title: string; head: string; base: string; body: string },
): Promise<{ html_url: string }> {
  return githubRequest<{ html_url: string }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    token,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function getRepositoryInstallationId(
  config: GitHubAppConfig,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const installation = await githubRequest<{ id: number }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      createAppJwt(config),
    );
    return String(installation.id);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      throw new GitHubRepositoryAccessError(
        `GitHub App cannot access ${owner}/${repo}. Check that the repository exists, the configured GITHUB_APP_ID and private key belong to the installed app, and the app installation includes this repository. After fixing access, submit a new task.`,
      );
    }
    throw error;
  }
}

export async function findOpenPullRequest(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<{ html_url: string } | null> {
  const params = new URLSearchParams({
    head: `${owner}:${head}`,
    base,
    state: "open",
  });
  const pulls = await githubRequest<Array<{ html_url: string }>>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params}`,
    token,
  );
  return pulls[0] ?? null;
}

export async function remoteBranchExists(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${branch}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(
      `GitHub branch lookup failed: ${response.status} ${await response.text()}`,
    );
  return true;
}
