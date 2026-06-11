import { execSync } from "node:child_process";
import * as vscode from "vscode";

export type VcsProvider = "github" | "gitlab";

export interface GitRemoteInfo {
  provider: VcsProvider;
  host: string;
  owner: string;
  repo: string;
  projectPath: string;
  webBase: string;
}

export interface VcsIdentity {
  provider: VcsProvider;
  username: string;
  email?: string;
  numericId?: number;
}

const SECRET_GITHUB_TOKEN = "claudeSkills.weeklyReport.githubToken";
const SECRET_GITLAB_TOKEN = "claudeSkills.weeklyReport.gitlabToken";

function isNoreplyEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email) || /noreply/i.test(email.split("@")[0] ?? "");
}

function parseRemoteUrl(url: string): GitRemoteInfo | undefined {
  const normalized = url.trim().replace(/\.git$/, "");

  const githubHttps = normalized.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/]+)/i);
  if (githubHttps && /github/i.test(githubHttps[1])) {
    const host = githubHttps[1];
    return {
      provider: "github",
      host,
      owner: githubHttps[2],
      repo: githubHttps[3],
      projectPath: `${githubHttps[2]}/${githubHttps[3]}`,
      webBase: `https://${host}`,
    };
  }

  const githubSsh = normalized.match(/git@([^:]+):([^/]+)\/(.+)/i);
  if (githubSsh && /github/i.test(githubSsh[1])) {
    const host = githubSsh[1];
    return {
      provider: "github",
      host,
      owner: githubSsh[2],
      repo: githubSsh[3],
      projectPath: `${githubSsh[2]}/${githubSsh[3]}`,
      webBase: `https://${host}`,
    };
  }

  const gitlabHttps = normalized.match(/https?:\/\/([^/]+)\/(.+)/i);
  if (gitlabHttps && /gitlab/i.test(gitlabHttps[1])) {
    const host = gitlabHttps[1];
    const projectPath = gitlabHttps[2];
    const parts = projectPath.split("/");
    return {
      provider: "gitlab",
      host,
      owner: parts.slice(0, -1).join("/"),
      repo: parts[parts.length - 1] ?? projectPath,
      projectPath,
      webBase: `https://${host}`,
    };
  }

  const gitlabSsh = normalized.match(/git@([^:]+):(.+)/i);
  if (gitlabSsh && /gitlab/i.test(gitlabSsh[1])) {
    const host = gitlabSsh[1];
    const projectPath = gitlabSsh[2];
    const parts = projectPath.split("/");
    return {
      provider: "gitlab",
      host,
      owner: parts.slice(0, -1).join("/"),
      repo: parts[parts.length - 1] ?? projectPath,
      projectPath,
      webBase: `https://${host}`,
    };
  }

  return undefined;
}

export function parseGitRemote(target: string): GitRemoteInfo | undefined {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: target,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseRemoteUrl(url);
  } catch {
    return undefined;
  }
}

async function readGhCliToken(): Promise<string | undefined> {
  try {
    return execSync("gh auth token", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

export async function resolveVcsToken(
  context: vscode.ExtensionContext,
  provider: VcsProvider
): Promise<string | undefined> {
  const secretKey = provider === "github" ? SECRET_GITHUB_TOKEN : SECRET_GITLAB_TOKEN;
  const stored = await context.secrets.get(secretKey);
  if (stored) {
    return stored;
  }
  if (provider === "github") {
    return readGhCliToken();
  }
  return process.env.GITLAB_TOKEN || process.env.GLAB_TOKEN || undefined;
}

export async function storeVcsToken(
  context: vscode.ExtensionContext,
  provider: VcsProvider,
  token: string
): Promise<void> {
  const secretKey = provider === "github" ? SECRET_GITHUB_TOKEN : SECRET_GITLAB_TOKEN;
  await context.secrets.store(secretKey, token);
}

export async function clearVcsToken(context: vscode.ExtensionContext, provider: VcsProvider): Promise<void> {
  const secretKey = provider === "github" ? SECRET_GITHUB_TOKEN : SECRET_GITLAB_TOKEN;
  await context.secrets.delete(secretKey);
}

async function githubApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function gitlabApi<T>(token: string, host: string, path: string, init?: RequestInit): Promise<T> {
  const base = host.includes("://") ? host : `https://${host}`;
  const res = await fetch(`${base}/api/v4${path}`, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab API ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchGitHubIdentity(token: string): Promise<VcsIdentity> {
  const user = await githubApi<{ login: string; id: number; email?: string | null }>(token, "/user");
  let email = user.email ?? undefined;
  if (!email || isNoreplyEmail(email)) {
    try {
      const emails = await githubApi<{ email: string; primary?: boolean }[]>(token, "/user/emails");
      email =
        emails.find((e) => e.primary && !isNoreplyEmail(e.email))?.email ??
        emails.find((e) => !isNoreplyEmail(e.email))?.email;
    } catch {
      // token may lack user:email
    }
  }
  return { provider: "github", username: user.login, email, numericId: user.id };
}

export async function fetchGitLabIdentity(token: string, host: string): Promise<VcsIdentity> {
  const user = await gitlabApi<{ username: string; id: number; email?: string; commit_email?: string }>(
    token,
    host,
    "/user"
  );
  const email = [user.email, user.commit_email].find((e) => e && !isNoreplyEmail(e));
  return { provider: "gitlab", username: user.username, email, numericId: user.id };
}

export async function fetchVcsIdentity(
  context: vscode.ExtensionContext,
  remote: GitRemoteInfo
): Promise<{ identity: VcsIdentity; token: string } | { error: string }> {
  const token = await resolveVcsToken(context, remote.provider);
  if (!token) {
    return {
      error:
        remote.provider === "github"
          ? "No GitHub token. Run Configure Weekly Report Email or gh auth login."
          : "No GitLab token. Run Configure Weekly Report Email or set GITLAB_TOKEN.",
    };
  }
  try {
    const identity =
      remote.provider === "github"
        ? await fetchGitHubIdentity(token)
        : await fetchGitLabIdentity(token, remote.host);
    return { identity, token };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function pickAndStoreVcsToken(
  context: vscode.ExtensionContext,
  remote: GitRemoteInfo
): Promise<{ token: string; identity: VcsIdentity } | { error: string }> {
  const providerLabel = remote.provider === "github" ? "GitHub" : "GitLab";
  const useCli =
    remote.provider === "github"
      ? await readGhCliToken()
      : process.env.GITLAB_TOKEN || process.env.GLAB_TOKEN;

  const choices: vscode.QuickPickItem[] = [];
  if (useCli) {
    choices.push({
      label: `Use existing ${providerLabel} CLI session`,
      description: remote.provider === "github" ? "Reads gh auth token" : "Reads GITLAB_TOKEN / GLAB_TOKEN",
    });
  }
  choices.push({
    label: `Paste ${providerLabel} personal access token`,
    description: "Stored securely in VS Code Secret Storage",
  });

  const pick = await vscode.window.showQuickPick(choices, {
    title: `Weekly report — ${providerLabel} account`,
    placeHolder: "Token is used to look up the email on your git account.",
  });
  if (!pick) {
    return { error: "Cancelled." };
  }

  let token = useCli;
  if (pick.label.startsWith("Paste")) {
    const scopes =
      remote.provider === "github" ? "read:user, user:email" : "read_user";
    const pasted = await vscode.window.showInputBox({
      title: `${providerLabel} personal access token`,
      prompt: `Scopes: ${scopes}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!pasted?.trim()) {
      return { error: "Cancelled." };
    }
    token = pasted.trim();
    await storeVcsToken(context, remote.provider, token);
  } else if (token) {
    await storeVcsToken(context, remote.provider, token);
  }

  if (!token) {
    return { error: `No ${providerLabel} token available.` };
  }

  try {
    const identity =
      remote.provider === "github" ? await fetchGitHubIdentity(token) : await fetchGitLabIdentity(token, remote.host);
    return { token, identity };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
