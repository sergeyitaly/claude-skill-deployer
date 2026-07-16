import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockedHome = os.tmpdir();
// branch-profiles.json (and its .lock file) is derived from os.homedir() at module load —
// isolate it from this machine's real ~/.claude/learning/branch-profiles.json.lock so tests
// can't collide with (or be blocked by) the actual running extension host.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHome };
});

const homes: string[] = [];

async function loadWithHome(home: string) {
  mockedHome = home;
  vi.resetModules();
  return import("./branchProfiles");
}

function lockPath(home: string): string {
  return path.join(home, ".claude", "learning", "branch-profiles.json.lock");
}

beforeEach(() => {
  mockedHome = fs.mkdtempSync(path.join(os.tmpdir(), "csd-branchlock-home-"));
  homes.push(mockedHome);
});

afterEach(() => {
  for (const home of homes) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  homes.length = 0;
});

describe("withBranchProfilesLock — cross-process mutex for the shared branch-profiles.json", () => {
  it("runs the protected function and removes the lock file afterward", async () => {
    const home = mockedHome;
    const mod = await loadWithHome(home);

    let ran = false;
    const result = mod.withBranchProfilesLock(() => {
      ran = true;
      // The lock file must exist while the protected function is running.
      expect(fs.existsSync(lockPath(home))).toBe(true);
      return 42;
    });

    expect(ran).toBe(true);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath(home))).toBe(false);
  });

  it("a held (non-stale) lock blocks execution until it is released by another process", async () => {
    const home = mockedHome;
    const mod = await loadWithHome(home);
    fs.mkdirSync(path.dirname(lockPath(home)), { recursive: true });
    fs.closeSync(fs.openSync(lockPath(home), "wx"));

    // Release the lock from a genuinely separate OS process — Atomics.wait blocks this
    // process's entire event loop, so a same-process setTimeout could never fire while
    // withBranchProfilesLock's synchronous poll loop is running.
    const { spawn } = await import("node:child_process");
    const releaser = spawn(process.execPath, [
      "-e",
      `setTimeout(() => { try { require("fs").unlinkSync(${JSON.stringify(lockPath(home))}); } catch {} }, 150);`,
    ]);

    const start = Date.now();
    let ran = false;
    mod.withBranchProfilesLock(() => {
      ran = true;
    });
    const elapsed = Date.now() - start;
    releaser.kill();

    expect(ran).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(120);
    expect(elapsed).toBeLessThan(2000); // proceeded because it was released, not the giveup timeout
  });

  it("steals a stale lock (old mtime) instead of waiting forever for a crashed holder", async () => {
    const home = mockedHome;
    const mod = await loadWithHome(home);
    fs.mkdirSync(path.dirname(lockPath(home)), { recursive: true });
    fs.closeSync(fs.openSync(lockPath(home), "wx"));
    const oldTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath(home), oldTime, oldTime);

    let ran = false;
    const start = Date.now();
    mod.withBranchProfilesLock(() => {
      ran = true;
    });
    const elapsed = Date.now() - start;

    expect(ran).toBe(true);
    expect(elapsed).toBeLessThan(500); // stolen quickly, not waited out to the 2s giveup
  });

  it("two saves for different repos both persist — no lost update across sequential lock cycles", async () => {
    const home = mockedHome;
    const mod = await loadWithHome(home);
    const store = { version: 1 as const, repos: {} as Record<string, unknown> };

    mod.withBranchProfilesLock(() => {
      store.repos["repo-a"] = { branch: "main" };
    });
    mod.withBranchProfilesLock(() => {
      store.repos["repo-b"] = { branch: "main" };
    });

    expect(Object.keys(store.repos)).toEqual(["repo-a", "repo-b"]);
  });
});
