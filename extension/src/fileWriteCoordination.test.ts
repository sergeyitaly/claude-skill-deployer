import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomic, acquireWriteLock, releaseWriteLock, copyFileWithRetry } from "./fileWriteCoordination";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "coord-"));
  workspaces.push(ws);
  fs.mkdirSync(path.join(ws, ".claude", "learning"), { recursive: true });
  return ws;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("fileWriteCoordination", () => {
  it("writes atomically and tracks locks", () => {
    const target = makeWorkspace();
    const file = path.join(target, ".claude", "learning", "test.json");
    expect(acquireWriteLock(target, "test.json", "extension")).toBe(true);
    writeJsonAtomic(file, { ok: true });
    releaseWriteLock(target, "test.json", "extension");
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ ok: true });
  });

  it("copyFileWithRetry skips unchanged files and overwrites when content differs", () => {
    const target = makeWorkspace();
    const src = path.join(target, "src.txt");
    const dest = path.join(target, "dest.txt");
    fs.writeFileSync(src, "hello", "utf-8");
    fs.writeFileSync(dest, "hello", "utf-8");
    copyFileWithRetry(src, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("hello");

    fs.writeFileSync(src, "updated", "utf-8");
    copyFileWithRetry(src, dest);
    expect(fs.readFileSync(dest, "utf-8")).toBe("updated");
  });
});
