import * as path from "node:path";

function encodeClaudeNormalizedPath(normalized: string): string {
  const win = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (win) {
    const rest = win[2].replace(/^\/+/, "").replace(/\//g, "-");
    return `${win[1].toLowerCase()}--${rest}`;
  }
  return normalized.replace(/\//g, "-").replace(/^-+/, "");
}

function encodeCursorNormalizedPath(normalized: string): string {
  const win = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (win) {
    const rest = win[2].replace(/^\/+/, "").replace(/\//g, "-");
    // Cursor uses a single dash after the drive letter (Claude uses "--").
    return `${win[1].toLowerCase()}-${rest}`;
  }
  return normalized.replace(/\//g, "-").replace(/^-+/, "");
}

/** Encode a workspace folder the way Claude Code stores project transcript dirs (~/.claude/projects). */
export function encodeWorkspacePath(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  // Windows and POSIX absolutes encode literally — path.resolve would mis-handle
  // "C:/..." on Linux CI and "/home/..." on Windows (prepends cwd drive).
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/")) {
    return encodeClaudeNormalizedPath(normalized);
  }
  return encodeClaudeNormalizedPath(path.resolve(target).replace(/\\/g, "/"));
}

/** Encode a workspace folder the way Cursor stores project transcript dirs (~/.cursor/projects). */
export function encodeCursorWorkspacePath(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/")) {
    return encodeCursorNormalizedPath(normalized);
  }
  return encodeCursorNormalizedPath(path.resolve(target).replace(/\\/g, "/"));
}

/** All known encoded project folder names for a workspace (Claude + Cursor). */
export function encodedWorkspaceProjectNames(target: string): string[] {
  return [encodeWorkspacePath(target), encodeCursorWorkspacePath(target)];
}

/** True when a Claude/Cursor transcript path belongs to this workspace folder. */
export function transcriptFileMatchesWorkspace(filePath: string, target: string): boolean {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx < 0 || !parts[projectsIdx + 1]) {
    return false;
  }
  const encoded = parts[projectsIdx + 1].toLowerCase();
  return encodedWorkspaceProjectNames(target).some((name) => name.toLowerCase() === encoded);
}

/** Decode workspace path from a transcript file under ~/.claude/projects or ~/.cursor/projects. */
export function workspaceFromTranscriptFile(filePath: string): string | undefined {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx < 0 || !parts[projectsIdx + 1]) {
    return undefined;
  }
  const encoded = parts[projectsIdx + 1];
  const claudeWin = encoded.match(/^([a-zA-Z])--(.+)$/);
  if (claudeWin) {
    const drive = claudeWin[1].toUpperCase();
    const rest = claudeWin[2].replace(/-/g, "/");
    return `${drive}:/${rest}`;
  }
  const cursorWin = encoded.match(/^([a-zA-Z])-(.+)$/);
  if (cursorWin) {
    const drive = cursorWin[1].toUpperCase();
    const rest = cursorWin[2].replace(/-/g, "/");
    return `${drive}:/${rest}`;
  }
  if (encoded.includes("-")) {
    // Best-effort inverse of POSIX encode — hyphens inside folder names cannot be recovered.
    return `/${encoded.replace(/-/g, "/")}`;
  }
  return undefined;
}

/** True when a transcript root is Cursor's ~/.cursor/projects tree. */
export function isCursorTranscriptRoot(root: string): boolean {
  return root.replace(/\\/g, "/").toLowerCase().includes("/.cursor/projects");
}
