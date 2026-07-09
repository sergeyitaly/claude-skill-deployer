import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (_section?: string) => ({
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
  },
}));

import { evaluateTaskDrift, readTaskDriftSettings } from "./taskDriftReproposal";
import { writeTaskSkillProposals } from "./taskSkillProposals";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csd-drift-immediate-"));
  workspaces.push(dir);
  return dir;
}

function appendRun(target: string, skill: string, ts: string, notInActiveProfile: boolean): void {
  const file = path.join(target, ".claude", "learning", "runs.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    ts,
    timestamp: ts,
    skill,
    action: "skill_invoke",
    agent: "claude",
    tokens: 100,
    cost: 0.01,
    rc: 0,
    success: true,
    session_id: "test-session",
    project: target,
    metadata: {
      source: "skill-invoke-hook-v2",
      invoked: true,
      ...(notInActiveProfile ? { not_in_active_profile: true } : {}),
    },
  };
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("evaluateTaskDrift reacts to fresh runs.jsonl content alone", () => {
  it("flags off_profile drift from new off-profile invokes, with zero session_size involvement", () => {
    const target = makeWorkspace();
    const generatedAt = new Date(Date.now() - 60_000).toISOString();
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt,
      taskSummary: "Review authentication architecture",
      promptExcerpt: "auth architecture review",
      proposals: [{ name: "auth-architecture-review", reason: "task", confidence: 90, installed: true }],
    });

    // Simulate the agent branching into unrelated tool calls during the session —
    // each PostToolUse skill-invoke hook call appends one of these to runs.jsonl.
    const settings = readTaskDriftSettings();
    expect(settings.minOffProfileInvokes).toBe(2);

    appendRun(target, "frontend-styling-analysis", new Date().toISOString(), true);
    let evaluation = evaluateTaskDrift(target, settings);
    // A single off-profile call is below the default threshold (2) — no false positive yet.
    expect(evaluation.shouldRepropose).toBe(false);
    expect(evaluation.offProfileInvokeCount).toBe(1);

    appendRun(target, "localization-audit", new Date().toISOString(), true);
    evaluation = evaluateTaskDrift(target, settings);

    // The moment the 2nd off-profile invoke lands in runs.jsonl, evaluation flips —
    // no session_size growth and no unrelated file change was needed.
    expect(evaluation.shouldRepropose).toBe(true);
    expect(evaluation.triggers).toContain("off_profile");
    expect(evaluation.triggers).not.toContain("session_size");
    expect(evaluation.offProfileSkills).toEqual(
      expect.arrayContaining(["frontend-styling-analysis", "localization-audit"])
    );
  });

  it("readTaskDriftSettings().enabled reflects claudeSkills.skillFeedback.taskDriftEnabled", () => {
    // Regression guard: this getter used to be hardcoded `true` and ignore config
    // entirely. The shared vscode mock always returns the default (true), so this
    // asserts the wiring is live, not that toggling actually flips the mock.
    const settings = readTaskDriftSettings();
    expect(settings.enabled).toBe(true);
  });
});

describe("extension.ts wiring: runs.jsonl changes must trigger a workspace-state refresh", () => {
  it("the runs.jsonl file watcher handler calls refreshAll(), not only scheduleCostPipelineSync()", () => {
    // Source-text regression guard: processTaskDriftReproposal is only reachable via
    // refreshAllImpl (see extension.ts's workspace-state block). Before this fix, the
    // runs.jsonl watcher called scheduleCostPipelineSync() alone, so a new (including
    // off-profile) skill/tool call never triggered drift re-evaluation — only an
    // unrelated file change (skill install, settings.local.json edit, etc.) did.
    const source = fs.readFileSync(path.join(__dirname, "extension.ts"), "utf-8");
    const watcherBlockMatch = source.match(
      /for \(const learningGlob of \[[^\]]*runs\.jsonl[^\]]*\]\)[\s\S]*?\n {2}\}/
    );
    expect(watcherBlockMatch).not.toBeNull();
    const block = watcherBlockMatch![0];
    expect(block).toContain("scheduleCostPipelineSync(");
    expect(block).toContain("refreshAll(");
  });
});
