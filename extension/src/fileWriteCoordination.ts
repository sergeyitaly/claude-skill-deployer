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
  renameWithRetry(tmp, filePath);
}

const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function renameWithRetry(src: string, dest: string, maxAttempts = 8): void {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= maxAttempts || !code || !RETRYABLE_FS_CODES.has(code)) {
        throw err;
      }
      sleepSync(40 * attempt);
    }
  }
}

function fileContentsEqual(a: string, b: string): boolean {
  try {
    if (!fs.existsSync(a) || !fs.existsSync(b)) {
      return false;
    }
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) {
      return false;
    }
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** Copy with temp-file replace and retries — avoids Windows EBUSY when hooks are in use. */
export function copyFileWithRetry(
  src: string,
  dest: string,
  opts?: { maxAttempts?: number; skipIfUnchanged?: boolean }
): void {
  if (opts?.skipIfUnchanged !== false && fileContentsEqual(src, dest)) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const maxAttempts = opts?.maxAttempts ?? 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tmp = path.join(
      path.dirname(dest),
      `.${path.basename(dest)}.tmp-${process.pid}-${Date.now()}`
    );
    try {
      fs.copyFileSync(src, tmp);
      renameWithRetry(tmp, dest, maxAttempts);
      return;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore cleanup failure
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= maxAttempts || !code || !RETRYABLE_FS_CODES.has(code)) {
        throw err;
      }
      sleepSync(50 * attempt);
    }
  }
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
