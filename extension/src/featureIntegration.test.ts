/**
 * Live workspace integration checks (skipped when paths or git are unavailable).
 * Complements unit tests by exercising real transcript dirs and repo layout.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentMirrorsNeedSync,
  computePerAgentCreditUsage,
  computeEnabledAgentsCreditUsage,
  loadAgentsManifest,
  missingAgentMirrorSkills,
} from "./agentOps";
import { formatCostDashboardHtml } from "./costDashboard";
import { assessAttributionHealth } from "./attributionHealth";
import { buildCostAttribution } from "./costAttribution";
import { computeUsageStats } from "./usageStats";
import { loadManifest } from "./skillOps";
import { lintWorkspaceSkills } from "./skillLint";
import { checkOfficialSkillUpdates } from "./officialSkillsSync";
import {
  encodeCursorWorkspacePath,
  encodeWorkspacePath,
  transcriptFileMatchesWorkspace,
} from "./workspaceTranscripts";
import { listTranscriptFiles } from "./transcriptParsers";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIBRARY_DIR = path.join(__dirname, "..", "skills_library");
const WORKSPACE = REPO_ROOT;

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

describe("feature integration (live workspace)", () => {
  it("loads bundled skill library and agents manifest", () => {
    const manifest = loadManifest(LIBRARY_DIR);
    expect(Object.keys(manifest.skills).length).toBeGreaterThan(0);
    const agents = loadAgentsManifest(LIBRARY_DIR);
    expect(agents.agents.claude.supportsUsageTranscripts).toBe(true);
    expect(agents.agents.cursor.supportsUsageTranscripts).toBe(true);
    expect(agents.agents.kiro.supportsUsageTranscripts).toBe(false);
    expect(agents.agents.copilot.supportsUsageTranscripts).toBe(false);
  });

  it("package.json contributes grouped extension settings", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
    expect(Array.isArray(pkg.contributes.configuration)).toBe(true);
    expect(pkg.contributes.configuration.some((c: { id: string }) => c.id === "claudeSkillsManager")).toBe(true);
    expect(
      pkg.contributes.commands.some((c: { command: string }) => c.command === "claudeSkills.openExtensionSettings")
    ).toBe(true);
  });

  it("encodes Claude and Cursor project folder names for this repo", () => {
    const normalized = WORKSPACE.replace(/\\/g, "/");
    const claudeEncoded = encodeWorkspacePath(WORKSPACE);
    const cursorEncoded = encodeCursorWorkspacePath(WORKSPACE);
    expect(claudeEncoded).toBeTruthy();
    expect(cursorEncoded).toBeTruthy();
    if (/^[a-zA-Z]:\//.test(normalized)) {
      expect(cursorEncoded).not.toBe(claudeEncoded);
      expect(cursorEncoded).toMatch(/^[a-z]-/);
      expect(claudeEncoded).toMatch(/^[a-z]--/);
    } else {
      // POSIX paths encode the same for Claude and Cursor (no drive letter).
      expect(cursorEncoded).toBe(claudeEncoded);
    }
  });

  it("matches Cursor agent-transcripts when present", () => {
    const cursorRoot = path.join(os.homedir(), ".cursor", "projects");
    if (!dirExists(cursorRoot)) {
      return;
    }
    const encoded = encodeCursorWorkspacePath(WORKSPACE);
    const projectDir = path.join(cursorRoot, encoded);
    if (!dirExists(projectDir)) {
      return;
    }
    const files = listTranscriptFiles(cursorRoot).filter((f) => transcriptFileMatchesWorkspace(f, WORKSPACE));
    expect(files.length).toBeGreaterThan(0);
  });

  it("reports per-agent credit usage for this workspace", () => {
    const credit = computeEnabledAgentsCreditUsage(LIBRARY_DIR, 14, WORKSPACE);
    expect(credit.workspaceScoped).toBe(true);
    expect(credit.daysBack).toBe(14);

    const rows = computePerAgentCreditUsage(LIBRARY_DIR, 14, WORKSPACE);
    expect(rows.length).toBe(4);
    const claude = rows.find((r) => r.agent === "claude");
    const cursor = rows.find((r) => r.agent === "cursor");
    const kiro = rows.find((r) => r.agent === "kiro");
    const copilot = rows.find((r) => r.agent === "copilot");
    expect(claude?.transcriptTracked).toBe(true);
    expect(cursor?.transcriptTracked).toBe(true);
    expect(kiro?.transcriptTracked).toBe(false);
    expect(copilot?.transcriptTracked).toBe(false);

    const cursorRoot = path.join(os.homedir(), ".cursor", "projects", encodeCursorWorkspacePath(WORKSPACE));
    if (dirExists(cursorRoot)) {
      expect(cursor!.sessions).toBeGreaterThan(0);
      expect(cursor!.tokens).toBeGreaterThan(0);
    }
  });

  it("builds cost dashboard HTML for this workspace", () => {
    const html = formatCostDashboardHtml(WORKSPACE, LIBRARY_DIR, "integration-nonce");
    expect(html).toContain("Cost Intelligence");
    expect(html).not.toMatch(/onclick=/);
    expect(html).toContain('nonce="integration-nonce"');
    expect(html).toContain("Claude Code");
    expect(html).toContain("Cursor");
    expect(html).toContain("Models by agent");
    expect(html).toContain("Trust");
  }, 30_000);

  it("computes attribution, usage stats, and health for this workspace", () => {
    const manifest = loadManifest(LIBRARY_DIR);
    const built = buildCostAttribution(WORKSPACE, LIBRARY_DIR);
    expect(built).toBeDefined();
    const health = assessAttributionHealth(WORKSPACE, LIBRARY_DIR);
    expect(health.summary).toBeTruthy();
    const stats = computeUsageStats(WORKSPACE, manifest);
    expect(stats).toBeDefined();
  });

  it("lints workspace skill mirrors when present", () => {
    const claudeSkills = path.join(WORKSPACE, ".claude", "skills");
    if (!dirExists(claudeSkills)) {
      return;
    }
    const issues = lintWorkspaceSkills(WORKSPACE);
    expect(Array.isArray(issues)).toBe(true);
  });

  it("detects agent mirror gaps for multi-agent sync", () => {
    const claudeSkills = path.join(WORKSPACE, ".claude", "skills");
    if (!dirExists(claudeSkills)) {
      return;
    }
    const gaps = missingAgentMirrorSkills(WORKSPACE, LIBRARY_DIR);
    const needsSync = agentMirrorsNeedSync(WORKSPACE, LIBRARY_DIR);
    expect(Array.isArray(gaps)).toBe(true);
    expect(typeof needsSync).toBe("boolean");
  });

  it("checks official Anthropic skills drift (network optional)", async () => {
    const result = await checkOfficialSkillUpdates(LIBRARY_DIR);
    expect(result.libraryDir).toBe(LIBRARY_DIR);
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it("has cost-control hook scripts in resources", () => {
    const hooksDir = path.join(__dirname, "..", "resources", "hooks");
    for (const name of ["hookPlatform.js", "budget-watch.js", "session-size-watch.js", "context-focus-watch.js", "practical-focus-watch.js", "task-drift-watch.js", "official-skills-watch.js"]) {
      expect(fs.existsSync(path.join(hooksDir, name))).toBe(true);
    }
  });
});
