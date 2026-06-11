import * as path from "node:path";

function encodeNormalizedPath(normalized: string): string {
  const win = normalized.match(/^([a-zA-Z]):\/(.*)$/);
  if (win) {
    const rest = win[2].replace(/^\/+/, "").replace(/\//g, "-");
    return `${win[1].toLowerCase()}--${rest}`;
  }
  return normalized.replace(/\//g, "-").replace(/^-+/, "");
}

/** Encode a workspace folder the same way Claude/Cursor store project transcript dirs. */
export function encodeWorkspacePath(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  // Windows and POSIX absolutes encode literally — path.resolve would mis-handle
  // "C:/..." on Linux CI and "/home/..." on Windows (prepends cwd drive).
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/")) {
    return encodeNormalizedPath(normalized);
  }
  return encodeNormalizedPath(path.resolve(target).replace(/\\/g, "/"));
}

/** True when a Claude/Cursor transcript path belongs to this workspace folder. */
export function transcriptFileMatchesWorkspace(filePath: string, target: string): boolean {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx < 0 || !parts[projectsIdx + 1]) {
    return false;
  }
  const encoded = parts[projectsIdx + 1];
  return encoded.toLowerCase() === encodeWorkspacePath(target).toLowerCase();
}

/** Decode workspace path from a transcript file under ~/.claude/projects or ~/.cursor/projects. */
export function workspaceFromTranscriptFile(filePath: string): string | undefined {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx < 0 || !parts[projectsIdx + 1]) {
    return undefined;
  }
  const encoded = parts[projectsIdx + 1];
  const win = encoded.match(/^([a-z])--(.+)$/i);
  if (win) {
    const drive = win[1].toUpperCase();
    const rest = win[2].replace(/-/g, "/");
    return `${drive}:/${rest}`;
  }
  if (encoded.includes("-")) {
    // Best-effort inverse of encode — hyphens inside folder names cannot be recovered.
    return `/${encoded.replace(/-/g, "/")}`;
  }
  return undefined;
}
