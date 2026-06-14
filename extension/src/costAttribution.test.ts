import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCostAttribution,
  cheapestAgentForSkill,
  costForRunRecord,
  detectEqualSplitCluster,
  formatEqualSplitWarning,
  resolveDisplayAttribution,
  sanitizeTranscriptSkills,
} from "./costAttribution";
import type { RunRecord } from "./usageStats";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cost-attr-"));
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

describe("costForRunRecord", () => {
  it("uses stored hook cost instead of blended token estimate", () => {
    const rec: RunRecord = {
      ts: "2026-06-13T20:54:35.705Z",
      skill: "profile-init",
      action: "skill_invoke",
      rc: 0,
      tokens: 33_508,
      cost: 0.0520116,
      success: true,
      metadata: { cost_method: "usage_breakdown", model: "claude-sonnet-4-6" },
      agent: "claude",
    };
    expect(costForRunRecord(rec)).toBeCloseTo(0.0520116, 6);
    expect(costForRunRecord(rec)).toBeLessThan(0.2);
  });
});

describe("buildCostAttribution", () => {
  it("aggregates per-skill cost from stored hook rows", () => {
    const target = makeWorkspace();
    const runs = path.join(target, ".claude", "learning", "runs.jsonl");
    const row = {
      ts: "2026-06-13T20:54:35.705Z",
      skill: "profile-init",
      action: "skill_invoke",
      agent: "claude",
      tokens: 33_508,
      cost: 0.0520116,
      rc: 0,
      success: true,
      session_id: "sess-1",
      metadata: { source: "skill-invoke-hook-v2", invoked: true, cost_method: "usage_breakdown" },
    };
    fs.writeFileSync(runs, `${JSON.stringify(row)}\n`, "utf-8");

    const libraryDir = path.join(__dirname, "..", "..", "skills_library");
    const built = buildCostAttribution(target, libraryDir);
    expect(built.skills["profile-init"]?.claude?.cost).toBeCloseTo(0.0520116, 6);
    expect(built.skills["profile-init"]?.claude?.cost).toBeLessThan(0.2);
  });
});

describe("detectEqualSplitCluster", () => {
  it("flags three skills with identical cost", () => {
    const map = {
      a: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
      b: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
      c: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
    };
    expect(detectEqualSplitCluster(map)?.count).toBe(3);
  });

  it("returns null for varied costs", () => {
    const map = {
      a: { claude: { tokens: 100, cost: 1.2, sessions: 1 } },
      b: { claude: { tokens: 100, cost: 3.4, sessions: 1 } },
    };
    expect(detectEqualSplitCluster(map)).toBeNull();
  });
});

describe("sanitizeTranscriptSkills", () => {
  it("purges equal-split transcript blob", () => {
    const stale = {
      a: { claude: { tokens: 1, cost: 579.51, sessions: 1 } },
      b: { claude: { tokens: 1, cost: 579.51, sessions: 1 } },
      c: { claude: { tokens: 1, cost: 579.51, sessions: 1 } },
    };
    const { skills, purgedStaleEqualSplit } = sanitizeTranscriptSkills(stale);
    expect(purgedStaleEqualSplit).toBe(true);
    expect(Object.keys(skills)).toHaveLength(0);
  });
});

describe("cheapestAgentForSkill", () => {
  it("picks agent with lowest cost per session", () => {
    const attribution = {
      "ci-pipeline-debug": {
        claude: { tokens: 100, cost: 2, sessions: 2 },
        cursor: { tokens: 80, cost: 0.5, sessions: 1 },
      },
    };
    expect(cheapestAgentForSkill("ci-pipeline-debug", attribution)).toBe("cursor");
  });

  it("returns null for missing skill or zero-session agents", () => {
    expect(cheapestAgentForSkill("missing", {})).toBeNull();
    expect(
      cheapestAgentForSkill("idle", { idle: { claude: { tokens: 0, cost: 0, sessions: 0 } } })
    ).toBeNull();
  });
});

describe("formatEqualSplitWarning", () => {
  it("includes count, cost, and reset guidance", () => {
    const msg = formatEqualSplitWarning({ count: 5, cost: 12.34 });
    expect(msg).toContain("5 skills");
    expect(msg).toContain("$12.34");
    expect(msg).toContain("Reset Mis-attributed Cost Data");
  });

  it("bolds reset label in html mode", () => {
    expect(formatEqualSplitWarning({ count: 3, cost: 1 }, true)).toContain("<b>Reset Mis-attributed Cost Data</b>");
  });
});

describe("resolveDisplayAttribution", () => {
  it("ignores stale transcript-only equal split when runs are clean", () => {
    const built = {
      skills: { real: { claude: { tokens: 10, cost: 0.5, sessions: 1 } } },
      transcriptSkills: {
        fake1: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
        fake2: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
        fake3: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
      },
    };
    const { staleEqualSplit, attribution } = resolveDisplayAttribution(built);
    expect(staleEqualSplit).toBe(false);
    expect(Object.keys(attribution)).toContain("real");
    expect(Object.keys(attribution)).not.toContain("fake1");
  });
});
