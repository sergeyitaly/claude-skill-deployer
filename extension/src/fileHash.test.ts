import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dirTreeHash, fileContentHash, invalidateFileHashCache, shouldCopyPath, stringContentHash } from "./fileHash";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-hash-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("fileHash", () => {
  it("detects identical and changed file content", () => {
    const root = tempDir();
    const src = path.join(root, "a.txt");
    const dest = path.join(root, "b.txt");
    fs.writeFileSync(src, "hello", "utf-8");
    expect(shouldCopyPath(src, dest)).toBe(true);
    fs.copyFileSync(src, dest);
    expect(shouldCopyPath(src, dest)).toBe(false);
    fs.writeFileSync(src, "hello!", "utf-8");
    expect(shouldCopyPath(src, dest)).toBe(true);
  });

  it("hashes directory trees", () => {
    const root = tempDir();
    const skill = path.join(root, "skill-a");
    fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: a\n---\n", "utf-8");
    fs.writeFileSync(path.join(skill, "scripts", "run.sh"), "echo ok", "utf-8");
    const h1 = dirTreeHash(skill);
    fs.writeFileSync(path.join(skill, "scripts", "run.sh"), "echo changed", "utf-8");
    const h2 = dirTreeHash(skill);
    expect(h1).toBeTruthy();
    expect(h2).toBeTruthy();
    expect(h1).not.toBe(h2);
  });

  it("stringContentHash is stable", () => {
    expect(stringContentHash("abc")).toBe(stringContentHash("abc"));
    expect(stringContentHash("abc")).not.toBe(stringContentHash("abcd"));
  });

  it("caches file hashes by mtime and size", () => {
    const root = tempDir();
    const file = path.join(root, "cached.txt");
    fs.writeFileSync(file, "v1", "utf-8");
    const h1 = fileContentHash(file);
    const h2 = fileContentHash(file);
    expect(h1).toBe(h2);
    fs.writeFileSync(file, "v2", "utf-8");
    invalidateFileHashCache(file);
    const h3 = fileContentHash(file);
    expect(h3).not.toBe(h1);
  });

  it("reuses hash when only mtime changes but size is unchanged", () => {
    const root = tempDir();
    const file = path.join(root, "mtime-only.txt");
    fs.writeFileSync(file, "stable-content", "utf-8");
    const h1 = fileContentHash(file);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    const h2 = fileContentHash(file);
    expect(h2).toBe(h1);
  });
});
