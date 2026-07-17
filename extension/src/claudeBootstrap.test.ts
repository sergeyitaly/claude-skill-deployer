import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeSkillsBootstrapBlock, syncClaudeSkillsBootstrap } from "./claudeBootstrap";
import { upsertClaudeMdBlock } from "./mcpForce";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bootstrap-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("buildClaudeSkillsBootstrapBlock", () => {
  it("renders a markdown table with name, globs, and description", () => {
    const block = buildClaudeSkillsBootstrapBlock([
      { name: "terraform-plan-review", detectGlobs: ["**/*.tf"], description: "Review terraform plans" },
    ]);
    expect(block).toContain("| terraform-plan-review | `**/*.tf` | Review terraform plans |");
    expect(block).toContain("## Installed Claude Skills");
  });

  it("escapes pipe characters in descriptions so they don't break the table", () => {
    const block = buildClaudeSkillsBootstrapBlock([
      { name: "x", detectGlobs: ["**/*"], description: "a | b" },
    ]);
    expect(block).toContain("a \\| b");
  });
});

describe("syncClaudeSkillsBootstrap", () => {
  it("does NOT create CLAUDE.md when there are no entries", () => {
    const ws = makeWorkspace();
    const result = syncClaudeSkillsBootstrap(ws, []);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(ws, "CLAUDE.md"))).toBe(false);
  });

  it("creates CLAUDE.md with the skills block when entries are present", () => {
    const ws = makeWorkspace();
    const result = syncClaudeSkillsBootstrap(ws, [
      { name: "github-actions-ci", detectGlobs: ["**/.github/workflows/*.yml"], description: "CI debugging" },
    ]);
    expect(result.ok).toBe(true);
    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content).toContain("github-actions-ci");
    expect(content).toContain("## Installed Claude Skills");
  });

  it("replaces the block on re-sync without duplicating it or touching other content", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# My project notes\n", "utf-8");

    syncClaudeSkillsBootstrap(ws, [{ name: "pdf", detectGlobs: ["**/*.pdf"] }]);
    syncClaudeSkillsBootstrap(ws, [{ name: "docx", detectGlobs: ["**/*.docx"] }]);

    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# My project notes");
    expect(content).toContain("docx");
    expect(content).not.toContain("| pdf |");
    const markerCount = (content.match(/<!-- claude-skills-manager:installed-skills -->/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  it("coexists with an MCP-Force block already present — neither writer clobbers the other", () => {
    const ws = makeWorkspace();
    // Simulate MCP-Force having already written its own marked block (same underlying
    // upsertClaudeMdBlock/lock mechanism the skills-bootstrap writer shares).
    upsertClaudeMdBlock(
      ws,
      "<!-- claude-skills-mcp-force -->",
      "<!-- /claude-skills-mcp-force -->",
      "<!-- claude-skills-mcp-force -->\n## MCP REQUIRED\n<!-- /claude-skills-mcp-force -->"
    );

    syncClaudeSkillsBootstrap(ws, [{ name: "terraform-module-ops", detectGlobs: ["**/*.tf"] }]);

    const content = fs.readFileSync(path.join(ws, "CLAUDE.md"), "utf-8");
    expect(content).toContain("MCP REQUIRED");
    expect(content).toContain("terraform-module-ops");
  });
});
