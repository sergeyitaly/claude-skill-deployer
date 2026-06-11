import * as fs from "node:fs";
import { parseSkillFrontmatter } from "./skillLint";

export interface CopilotSkillEntry {
  name: string;
  detectGlobs: string[];
  description?: string;
}

/** Strip YAML frontmatter and return body markdown. */
export function skillBodyWithoutFrontmatter(raw: string): string {
  const fm = parseSkillFrontmatter(raw);
  if (!fm) {
    return raw.trim();
  }
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? raw.slice(match[0].length).trim() : raw.trim();
}

export function parseSkillFrontmatterMeta(raw: string): { description?: string } {
  const fm = parseSkillFrontmatter(raw);
  return fm?.description ? { description: fm.description } : {};
}

function escapeYamlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatApplyToYaml(globs: string[]): string {
  if (globs.length === 1) {
    return `applyTo: "${globs[0]}"`;
  }
  const lines = ["applyTo:"];
  for (const g of globs) {
    lines.push(`  - ${g}`);
  }
  return lines.join("\n");
}

/** Convert detect_globs to Copilot applyTo list (YAML array under frontmatter). */
export function buildCopilotInstructionsFile(
  skillName: string,
  detectGlobs: string[],
  skillMdPath: string
): string {
  const raw = fs.readFileSync(skillMdPath, "utf-8");
  const body = skillBodyWithoutFrontmatter(raw);
  const { description } = parseSkillFrontmatterMeta(raw);
  const applyTo = detectGlobs.length > 0 ? detectGlobs : ["**/*"];
  const lines = ["---"];
  if (description) {
    lines.push(`name: "${escapeYamlString(skillName)}"`, `description: "${escapeYamlString(description)}"`);
  }
  lines.push(formatApplyToYaml(applyTo), "---", "", `# ${skillName}`, "", body, "");
  return lines.join("\n");
}

/** Always-on Copilot index: points agent at path-specific instructions under .github/instructions/. */
export function buildCopilotBootstrapInstructions(skills: CopilotSkillEntry[]): string {
  const lines = [
    "# AI agent instructions (Claude Skills Manager)",
    "",
    "This repository deploys **native GitHub Copilot instructions** under `.github/instructions/*.instructions.md`.",
    "When you work on files matching a skill's `applyTo` globs, follow that skill's instruction file fully.",
    "",
    "## Installed skills",
    "",
    "| Skill | Applies when |",
    "|---|---|",
  ];

  for (const s of skills) {
    const globs = s.detectGlobs.length > 0 ? s.detectGlobs.join(", ") : "**/*";
    const note = s.description ? ` — ${s.description}` : "";
    lines.push(`| ${s.name} | \`${globs}\`${note} |`);
  }

  lines.push(
    "",
    "## How to use in agent mode",
    "",
    "1. Prefer instructions whose `applyTo` matches the files you are editing.",
    "2. If multiple match, combine them; if they conflict, ask the user.",
    "3. Do not invent procedures — use the installed `.instructions.md` files.",
    "4. Claude Code skills live under `.claude/skills/`; Copilot uses this folder.",
    ""
  );
  return lines.join("\n");
}

export function writeCopilotBootstrap(target: string, skills: CopilotSkillEntry[]): string {
  const githubDir = `${target}/.github`.replace(/\\/g, "/");
  const file = `${githubDir}/copilot-instructions.md`;
  fs.mkdirSync(githubDir, { recursive: true });
  const content = buildCopilotBootstrapInstructions(skills);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}
