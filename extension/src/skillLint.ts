import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId, enabledAgents, loadAgentsManifest } from "./agentOps";
import { listEffectiveEnabledSkills } from "./skillOps";

export interface SkillLintIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface SkillLintResult {
  skill: string;
  filePath: string;
  issues: SkillLintIssue[];
  ok: boolean;
}

export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

export function parseSkillFrontmatter(raw: string): Record<string, string> | null {
  return parseFrontmatterBlock(raw);
}
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function maxSkillBytes(): number {
  return vscode.workspace.getConfiguration("claudeSkills.lint").get<number>("maxSkillBytes", 262_144);
}

function maxDescriptionLength(): number {
  return vscode.workspace.getConfiguration("claudeSkills.lint").get<number>("maxDescriptionLength", 500);
}

function requireFrontmatter(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.lint").get<boolean>("requireFrontmatter", true);
}

const BLOCK_SCALAR_RE = /^([a-zA-Z0-9_-]+):\s*(\||\|-|>|>-)\s*$/;

function parseFrontmatterBlock(raw: string): Record<string, string> | null {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return null;
  }
  const out: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const block = line.match(BLOCK_SCALAR_RE);
    if (block) {
      const blockLines: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (/^[a-zA-Z0-9_-]+:\s*/.test(next)) {
          break;
        }
        const indent = next.match(/^(\s+)/);
        if (!indent) {
          break;
        }
        i++;
        blockLines.push(next.slice(indent[1].length).trimEnd());
      }
      out[block[1]] = blockLines.join("\n").trim();
      continue;
    }

    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

export function lintSkillMd(skillName: string, raw: string, filePath = ""): SkillLintResult {
  const issues: SkillLintIssue[] = [];

  if (!SKILL_NAME_RE.test(skillName)) {
    issues.push({
      severity: "error",
      code: "invalid-name",
      message: `Skill directory name must match ${SKILL_NAME_RE} (got "${skillName}")`,
    });
  }

  const fmName = parseFrontmatterBlock(raw)?.name;
  if (fmName && fmName !== skillName) {
    issues.push({
      severity: "error",
      code: "name-mismatch",
      message: `Frontmatter name "${fmName}" must match directory "${skillName}"`,
    });
  }

  const bytes = Buffer.byteLength(raw, "utf-8");
  if (bytes > maxSkillBytes()) {
    issues.push({
      severity: "warning",
      code: "size-cap",
      message: `SKILL.md is ${bytes} bytes (cap ${maxSkillBytes()})`,
    });
  }

  const fm = parseFrontmatterBlock(raw);
  if (!fm && requireFrontmatter()) {
    issues.push({
      severity: "error",
      code: "missing-frontmatter",
      message: "Missing YAML frontmatter (--- block at top)",
    });
  } else if (fm) {
    const desc = fm.description?.trim();
    if (!desc) {
      issues.push({
        severity: "error",
        code: "missing-description",
        message: "Frontmatter description is required",
      });
    } else if (desc.length > maxDescriptionLength()) {
      issues.push({
        severity: "warning",
        code: "long-description",
        message: `Description is ${desc.length} chars (recommended max ${maxDescriptionLength()})`,
      });
    }
    if (!fm.name) {
      issues.push({
        severity: "warning",
        code: "missing-fm-name",
        message: "Frontmatter name field recommended (should match folder name)",
      });
    }
  }

  const body = raw.replace(FRONTMATTER_RE, "").trim();
  if (body.length < 40) {
    issues.push({
      severity: "warning",
      code: "thin-body",
      message: "Skill body is very short — add usage guidance",
    });
  }

  const hasError = issues.some((i) => i.severity === "error");
  return { skill: skillName, filePath, issues, ok: !hasError };
}

export function lintSkillFile(skillName: string, skillMdPath: string): SkillLintResult {
  let raw = "";
  try {
    raw = fs.readFileSync(skillMdPath, "utf-8");
  } catch {
    return {
      skill: skillName,
      filePath: skillMdPath,
      issues: [{ severity: "error", code: "missing-file", message: `Cannot read ${skillMdPath}` }],
      ok: false,
    };
  }
  return lintSkillMd(skillName, raw, skillMdPath);
}

export function lintWorkspaceSkills(target: string): SkillLintResult[] {
  const root = `${target}/.claude/skills`.replaceAll("\\", "/");
  const dir = root;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: SkillLintResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillMd = `${dir}/${entry.name}/SKILL.md`;
    if (fs.existsSync(skillMd)) {
      results.push(lintSkillFile(entry.name, skillMd));
    }
  }
  return results;
}

export interface AgentMirrorLintResult extends SkillLintResult {
  agent: AgentId;
}

function lintSkillMdMirror(dir: string, skill: string, agent: AgentId): AgentMirrorLintResult | undefined {
  const skillMd = path.join(dir, skill, "SKILL.md");
  if (!fs.existsSync(skillMd)) {
    return undefined;
  }
  return { ...lintSkillFile(skill, skillMd), agent };
}

function lintCopilotInstructionsMirror(dir: string, skill: string, agent: AgentId): AgentMirrorLintResult {
  const file = path.join(dir, `${skill}.instructions.md`);
  const issues: SkillLintIssue[] = [];
  if (!fs.existsSync(file)) {
    issues.push({
      severity: "warning",
      code: "missing-mirror",
      message: `Copilot instructions mirror missing: ${file}`,
    });
  } else if (fs.readFileSync(file, "utf-8").trim().length === 0) {
    issues.push({
      severity: "warning",
      code: "empty-mirror",
      message: `Copilot instructions mirror is empty: ${file}`,
    });
  }
  return { skill, filePath: file, issues, agent, ok: !issues.some((i) => i.severity === "error") };
}

function lintAgentMirrorsForDef(
  target: string,
  agentId: AgentId,
  def: { format: string; workspaceDir: string; supportsWorkspace: boolean },
  skills: string[]
): AgentMirrorLintResult[] {
  if (!def.supportsWorkspace) {
    return [];
  }
  const dir = path.join(target, def.workspaceDir);
  if (def.format === "skill-md") {
    return skills
      .map((skill) => lintSkillMdMirror(dir, skill, agentId))
      .filter((r): r is AgentMirrorLintResult => r !== undefined);
  }
  if (def.format === "copilot-instructions") {
    return skills.map((skill) => lintCopilotInstructionsMirror(dir, skill, agentId));
  }
  return [];
}

/**
 * Lint skill mirrors copied to other agents' workspace dirs:
 * - "skill-md" agents (Cursor, Kiro) get the same SKILL.md checks as the Claude source of truth.
 * - "copilot-instructions" mirrors are transformed files; checked for existence/non-empty only.
 */
export function lintAgentMirrors(target: string, libraryDir: string, skills: string[]): AgentMirrorLintResult[] {
  let manifest;
  try {
    manifest = loadAgentsManifest(libraryDir);
  } catch {
    return [];
  }

  const results: AgentMirrorLintResult[] = [];
  for (const agentId of enabledAgents(libraryDir)) {
    if (agentId === "claude") {
      continue;
    }
    const def = manifest.agents[agentId];
    if (!def) {
      continue;
    }
    results.push(...lintAgentMirrorsForDef(target, agentId, def, skills));
  }

  return results;
}

export function formatLintReport(results: SkillLintResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    if (r.issues.length === 0) {
      continue;
    }
    const agent = (r as AgentMirrorLintResult).agent;
    const label = agent ? `${r.skill} (${agent})` : r.skill;
    for (const issue of r.issues) {
      lines.push(`[${issue.severity}] ${label}: ${issue.message}`);
    }
  }
  return lines;
}

/** Lint workspace skills; log issues; return false if errors and blockOnError is on. */
export function lintOnSync(target: string, log: (line: string) => void): boolean {
  if (!vscode.workspace.getConfiguration("claudeSkills.lint").get<boolean>("enabled", true)) {
    return true;
  }
  const results = lintWorkspaceSkills(target);
  const lines = formatLintReport(results);
  for (const line of lines) {
    log(`SKILL lint: ${line}`);
  }
  const block = vscode.workspace.getConfiguration("claudeSkills.lint").get<boolean>("blockSyncOnError", false);
  const hasError = results.some((r) => !r.ok);
  if (hasError && block) {
    log("SKILL lint: sync blocked — fix errors or set claudeSkills.lint.blockSyncOnError to false.");
    return false;
  }
  return true;
}

/** Lint skill mirrors copied to Cursor/Kiro/Copilot after multi-agent sync. Logs only — never blocks. */
export function lintAgentMirrorsOnSync(target: string, libraryDir: string, log: (line: string) => void): void {
  if (!vscode.workspace.getConfiguration("claudeSkills.lint").get<boolean>("enabled", true)) {
    return;
  }
  // Only expect mirrors for skills enabled for this user (not skillOverrides "off").
  const skills = listEffectiveEnabledSkills(target);
  if (skills.length === 0) {
    return;
  }
  const results = lintAgentMirrors(target, libraryDir, skills);
  for (const line of formatLintReport(results)) {
    log(`SKILL lint: ${line}`);
  }
}
