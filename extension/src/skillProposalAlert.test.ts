import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTaskSkillProposals } from "./taskSkillProposals";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) => {
        if (key === "promptOnHighUsage") {
          return true;
        }
        if (key === "monthlyCreditThresholdPercent") {
          return 50;
        }
        if (key === "monthlyCreditsUsd") {
          return 100;
        }
        return defaultValue;
      },
    }),
  },
}));

vi.mock("./agentOps", () => ({
  computeEnabledAgentsCreditUsage: () => ({
    totalCost: 80,
    totalTokens: 1_000_000,
    sessionCount: 1,
    daysBack: 30,
    byDay: [],
    byModel: [],
  }),
}));

vi.mock("./branchProfiles", () => ({
  getCurrentBranch: () => "feature/heavy",
}));

function monthIso(day = 15): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00.000Z`;
}

function writeRuns(target: string, rows: object[]): void {
  const dir = path.join(target, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "runs.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8"
  );
}

function initGitBranch(_target: string, _branch: string): void {
  // branch resolved via mocked getCurrentBranch
}

describe("evaluateHighUsageSkillProposalAlert", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("triggers when branch spend exceeds monthly threshold", async () => {
    const { evaluateHighUsageSkillProposalAlert } = await import("./skillProposalAlert");
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-alert-"));
    const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    fs.mkdirSync(path.join(libraryDir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(libraryDir, "manifest.json"),
      JSON.stringify({
        skills: {
          "ci-pipeline-debug": { description: "CI debug", detect_globs: ["**/.gitlab-ci.yml"] },
        },
      }),
      "utf-8"
    );
    fs.mkdirSync(path.join(libraryDir, "ci-pipeline-debug"), { recursive: true });
    fs.writeFileSync(path.join(libraryDir, "ci-pipeline-debug", "SKILL.md"), "---\nname: ci\n---\n", "utf-8");

    initGitBranch(target, "feature/heavy");
    writeRuns(target, [
      {
        ts: monthIso(),
        skill: "general",
        action: "run",
        agent: "claude",
        tokens: 500_000,
        cost: 55,
        rc: 0,
        branch: "feature/heavy",
      },
    ]);
    writeTaskSkillProposals(target, {
      version: 1,
      generatedAt: monthIso(),
      taskSummary: "Fix CI",
      proposals: [{ name: "ci-pipeline-debug", reason: "CI task", confidence: 90, installed: false }],
    });

    const result = evaluateHighUsageSkillProposalAlert(target, libraryDir);
    expect(result).not.toBeNull();
    expect(result!.scope.usagePercent).toBeGreaterThanOrEqual(50);
    expect(result!.toInstall.map((p) => p.name)).toContain("ci-pipeline-debug");
  });
});
