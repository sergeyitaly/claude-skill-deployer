import * as fs from "node:fs";
import * as path from "node:path";

export type LockOwner = "extension" | "agent" | "hook" | "collector";

export interface FileLockEntry {
  status: "idle" | "pending" | "locked";
  lockedBy?: LockOwner;
  version: number;
  updatedAt: string;
}

export interface WriteLocksFile {
  version: 1;
  files: Record<string, FileLockEntry>;
}

function locksPath(target: string): string {
  return path.join(target, ".claude", "learning", "write-locks.json");
}

function readLocks(target: string): WriteLocksFile {
  const file = locksPath(target);
  if (!fs.existsSync(file)) {
    return { version: 1, files: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as WriteLocksFile;
    if (parsed.version !== 1 || !parsed.files) {
      return { version: 1, files: {} };
    }
    return parsed;
  } catch {
    return { version: 1, files: {} };
  }
}

function writeLocks(target: string, locks: WriteLocksFile): void {
  writeJsonAtomic(locksPath(target), locks);
}

/** Atomic JSON write (temp file → rename). */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/** Register coordination metadata for a logical file key (e.g. profile.local.json). */
export function setWriteLock(
  target: string,
  fileKey: string,
  entry: Partial<FileLockEntry> & { status: FileLockEntry["status"]; lockedBy?: LockOwner }
): FileLockEntry {
  const locks = readLocks(target);
  const prev = locks.files[fileKey];
  const next: FileLockEntry = {
    status: entry.status,
    lockedBy: entry.lockedBy,
    version: (prev?.version ?? 0) + (entry.status === "idle" ? 0 : 1),
    updatedAt: new Date().toISOString(),
  };
  if (entry.status === "idle") {
    next.lockedBy = undefined;
    next.version = prev?.version ?? 0;
  }
  locks.files[fileKey] = next;
  writeLocks(target, locks);
  return next;
}

export function acquireWriteLock(target: string, fileKey: string, owner: LockOwner): boolean {
  const locks = readLocks(target);
  const current = locks.files[fileKey];
  if (current?.status === "locked" && current.lockedBy && current.lockedBy !== owner) {
    return false;
  }
  setWriteLock(target, fileKey, { status: "locked", lockedBy: owner });
  return true;
}

export function releaseWriteLock(target: string, fileKey: string, owner: LockOwner): void {
  const locks = readLocks(target);
  const current = locks.files[fileKey];
  if (current?.lockedBy && current.lockedBy !== owner) {
    return;
  }
  setWriteLock(target, fileKey, { status: "idle" });
}

export function getWriteLock(target: string, fileKey: string): FileLockEntry | undefined {
  return readLocks(target).files[fileKey];
}

/** Atomic write + bump lock version for the file key. */
export function writeCoordinatedJson(
  target: string,
  filePath: string,
  fileKey: string,
  owner: LockOwner,
  data: unknown
): void {
  acquireWriteLock(target, fileKey, owner);
  try {
    writeJsonAtomic(filePath, data);
    setWriteLock(target, fileKey, { status: "pending", lockedBy: owner });
  } finally {
    releaseWriteLock(target, fileKey, owner);
  }
}
