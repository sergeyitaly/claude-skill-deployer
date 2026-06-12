import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeCursorWorkspacePath, encodeWorkspacePath } from "./workspaceTranscripts";
import { computeCreditUsageFromRoots } from "./usageCost";

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
});
