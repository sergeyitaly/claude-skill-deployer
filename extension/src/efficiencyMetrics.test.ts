import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fixed (not mkdtemp-random) path: some transitively-imported modules (e.g.
// mcpUsageLog.ts) call os.homedir() at their own top-level module-load time, before this
// file's own top-level statements would run — so the mock factory below can't reference a
// variable initialized later in this file (TDZ). A deterministic path sidesteps that.
const HOME_DIR = path.join(os.tmpdir(), "hace-home-test-fixture");

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => path.join(actual.tmpdir(), "hace-home-test-fixture") };
});

import { computeEfficiencyMetrics, computeHaceMetrics } from "./efficiencyMetrics";
import { encodeWorkspacePath } from "./workspaceTranscripts";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hace-ws-"));
  workspaces.push(dir);
  fs.mkdirSync(path.join(dir, ".claude", "learning"), { recursive: true });
  return dir;
}

/** Writes a minimal, real Claude Code session transcript with 2 user/assistant turns —
 *  enough for parseSessionFile() to produce real HaceTurn data (not the noData:true path). */
function writeSessionTranscript(target: string): void {
  const projectDir = path.join(HOME_DIR, ".claude", "projects", encodeWorkspacePath(target).toLowerCase());
  fs.mkdirSync(projectDir, { recursive: true });
  const base = Date.now() - 10 * 60_000;
  const lines = [
    { type: "user", timestamp: new Date(base).toISOString(), message: { role: "user", content: "Fix the bug in the parser, please look at the whole file first" } },
    { type: "assistant", timestamp: new Date(base + 5_000).toISOString(), requestId: "req-1", message: { role: "assistant", content: [{ type: "text", text: "Looking now." }], usage: { output_tokens: 500 } } },
    { type: "user", timestamp: new Date(base + 60_000).toISOString(), message: { role: "user", content: "Great, that looks correct, thanks for the thorough fix" } },
    { type: "assistant", timestamp: new Date(base + 65_000).toISOString(), requestId: "req-2", message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: { output_tokens: 300 } } },
  ];
  fs.writeFileSync(path.join(projectDir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
}

function readHaceSessions(target: string): unknown[] {
  const file = path.join(target, ".claude", "learning", "hace-sessions.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
  fs.rmSync(path.join(HOME_DIR, ".claude", "projects"), { recursive: true, force: true });
});

describe("computeHaceMetrics / computeEfficiencyMetrics — hace-sessions.jsonl persistence is opt-in", () => {
  it("regression: does NOT write hace-sessions.jsonl by default (dashboard render / usage-report callers)", () => {
    // Live-reported bug: appendHaceSession() used to run unconditionally on every call, so
    // opening the Cost Dashboard (or any other read-only view of efficiency metrics) wrote
    // another near-identical row to the trend log every time, regardless of whether a real
    // session had actually concluded — confirmed live: duplicate-looking rows every ~5 min.
    const target = makeWorkspace();
    writeSessionTranscript(target);

    const metrics = computeEfficiencyMetrics(target, 14);

    expect(metrics.hace.noData).toBe(false);
    expect(readHaceSessions(target)).toHaveLength(0);
  });

  it("writes exactly one hace-sessions.jsonl row when persistHaceSnapshot is true (the real session-stop path)", () => {
    const target = makeWorkspace();
    writeSessionTranscript(target);

    computeEfficiencyMetrics(target, 14, true);

    const rows = readHaceSessions(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("haceScore");
    expect(rows[0]).toHaveProperty("turns");
  });

  it("computeHaceMetrics itself defaults to not persisting, matching computeEfficiencyMetrics's default", () => {
    const target = makeWorkspace();
    writeSessionTranscript(target);

    const result = computeHaceMetrics(target, 90, 14);

    expect(result.noData).toBe(false);
    expect(readHaceSessions(target)).toHaveLength(0);
  });
});
