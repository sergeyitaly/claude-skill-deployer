import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCursorWorkspacePath, encodeWorkspacePath } from "./workspaceTranscripts";
import { computeCreditUsageFromRoots, spendPrefixForCreditSummary, aggregateHookModelUsageByAgent } from "./usageCost";
import { invalidateLearningCache } from "./runsStore";

const tempDirs: string[] = [];

function makeTranscriptRoot(workspace: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cost-"));
  tempDirs.push(root);
  const encoded = encodeWorkspacePath(workspace);
  const sessionDir = path.join(root, "projects", encoded);
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "session.jsonl");
  const ts = new Date().toISOString();
  const line = JSON.stringify({
    timestamp: ts,
    sessionId: "sess-1",
    message: {
      model: "claude-sonnet-4",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 200,
      },
    },
  });
  fs.writeFileSync(sessionFile, line + "\n", "utf-8");
  fs.utimesSync(sessionFile, new Date(), new Date());
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("computeCreditUsageFromRoots", () => {
  it("aggregates recent transcript usage by day and model", () => {
    const workspace = "/home/runner/work/claude-skill-deployer/claude-skill-deployer";
    const root = makeTranscriptRoot(workspace);
    const summary = computeCreditUsageFromRoots([root], 7);

    expect(summary.sessionCount).toBe(1);
    expect(summary.totalTokens).toBe(1700);
    expect(summary.totalCost).toBeGreaterThan(0);
    expect(summary.byModel.some((m) => m.model === "claude-sonnet-4")).toBe(true);
    expect(summary.byModel[0]?.costBasis).toBe("usage");
    expect(summary.byDay.length).toBeGreaterThan(0);
  });

  it("scopes to workspace when workspaceTarget is set", () => {
    const workspace = "/home/runner/work/claude-skill-deployer/claude-skill-deployer";
    const other = "/home/runner/work/other-repo/other-repo";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cost-scope-"));
    tempDirs.push(root);

    for (const ws of [workspace, other]) {
      const encoded = encodeWorkspacePath(ws);
      const sessionDir = path.join(root, "projects", encoded);
      fs.mkdirSync(sessionDir, { recursive: true });
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: `sess-${encoded}`,
        message: {
          model: "claude-sonnet-4",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
      const file = path.join(sessionDir, "session.jsonl");
      fs.writeFileSync(file, line + "\n", "utf-8");
      fs.utimesSync(file, new Date(), new Date());
    }

    const scoped = computeCreditUsageFromRoots([root], 7, workspace);
    const all = computeCreditUsageFromRoots([root], 7);

    expect(scoped.sessionCount).toBe(1);
    expect(scoped.workspaceScoped).toBe(true);
    expect(all.sessionCount).toBe(2);
    expect(all.workspaceScoped).toBe(false);
  });

  it("estimates Cursor agent-transcript usage without Claude-style usage lines", () => {
    const workspace = "C:/Users/runner/claude-skills-deployer";
    const root = path.join(os.tmpdir(), `usage-cost-cursor-${Date.now()}`);
    fs.mkdirSync(path.join(root, ".cursor", "projects"), { recursive: true });
    tempDirs.push(root);
    const encoded = encodeCursorWorkspacePath(workspace);
    const sessionDir = path.join(root, ".cursor", "projects", encoded, "agent-transcripts", "uuid-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "uuid-1.jsonl");
    const content = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "a".repeat(4000) }] },
      }),
    ].join("\n");
    fs.writeFileSync(sessionFile, content + "\n", "utf-8");
    fs.utimesSync(sessionFile, new Date(), new Date());

    const cursorProjects = path.join(root, ".cursor", "projects");
    const scoped = computeCreditUsageFromRoots([cursorProjects], 7, workspace);
    expect(scoped.workspaceScoped).toBe(true);
    expect(scoped.sessionCount).toBe(1);
    expect(scoped.totalTokens).toBeGreaterThan(0);
    expect(scoped.totalCost).toBeGreaterThan(0);
    expect(scoped.byModel.some((m) => m.model === "cursor-agent")).toBe(true);
    const cursorRow = scoped.byModel.find((m) => m.model === "cursor-agent");
    expect(cursorRow?.costBasis).toBe("size_estimate");
  });

  it("ignores all-zero usage lines", () => {
    const workspace = "/tmp/zero-usage";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cost-zero-"));
    tempDirs.push(root);
    const encoded = encodeWorkspacePath(workspace);
    const sessionDir = path.join(root, "projects", encoded);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "zero.jsonl");
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      message: {
        model: "<synthetic>",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    fs.writeFileSync(sessionFile, line + "\n", "utf-8");
    fs.utimesSync(sessionFile, new Date(), new Date());

    const summary = computeCreditUsageFromRoots([root], 7);
    expect(summary.totalTokens).toBe(0);
    expect(summary.sessionCount).toBe(0);
  });

  it("labels API spend when all models have usage metadata", () => {
    const workspace = "/tmp/api-prefix";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cost-prefix-"));
    tempDirs.push(root);
    const encoded = encodeWorkspacePath(workspace);
    const sessionDir = path.join(root, "projects", encoded);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "api.jsonl");
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      message: {
        model: "claude-sonnet-4",
        usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    fs.writeFileSync(sessionFile, line + "\n", "utf-8");
    fs.utimesSync(sessionFile, new Date(), new Date());

    const summary = computeCreditUsageFromRoots([root], 7, workspace);
    expect(spendPrefixForCreditSummary(summary)).toBe("API");
  });

  it("aggregates hook model usage for cursor agent from runs.jsonl", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hook-model-"));
    tempDirs.push(workspace);
    const learningDir = path.join(workspace, ".claude", "learning");
    fs.mkdirSync(learningDir, { recursive: true });
    fs.writeFileSync(
      path.join(learningDir, "runs.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        skill: "profile-init",
        action: "skill_invoke",
        agent: "cursor",
        tokens: 12000,
        cost: 0.08,
        rc: 0,
        success: true,
        session_id: "c1",
        project: workspace,
        metadata: {
          source: "skill-invoke-hook-v2",
          invoked: true,
          model: "claude-sonnet-4-6",
          cost_method: "usage_breakdown",
          usage: { input_tokens: 8000, output_tokens: 4000 },
        },
      }) + "\n",
      "utf-8"
    );

    invalidateLearningCache(workspace);
    const byAgent = aggregateHookModelUsageByAgent(workspace, 14);
    const cursorModels = byAgent.cursor ?? [];
    expect(cursorModels.length).toBeGreaterThan(0);
    expect(cursorModels[0].model).toBe("claude-sonnet-4-6");
    expect(cursorModels[0].costBasis).toBe("usage");
    expect(cursorModels[0].cost).toBeCloseTo(0.08, 2);
  });
});
