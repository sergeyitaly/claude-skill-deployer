import * as fs from "node:fs";
import { parseSkillFrontmatter } from "./skillLint";

export interface CopilotSkillEntry {
  name: string;
  detectGlobs: string[];
  description?: string;
}

export interface InstructionValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  filePath: string;
  skillName: string;
  appliedGlobs: string[];
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

/** Validate that a Copilot instruction file is properly formed and has valid metadata. */
export function validateInstructionFile(filePath: string, skillName: string, detectGlobs: string[]): InstructionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let appliedGlobs = detectGlobs.length > 0 ? detectGlobs : ["**/*"];

  if (!fs.existsSync(filePath)) {
    errors.push(`Instruction file not found: ${filePath}`);
    return { valid: false, errors, warnings, filePath, skillName, appliedGlobs };
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    
    // Validate YAML frontmatter structure
    if (!content.startsWith("---")) {
      errors.push("Missing leading YAML frontmatter delimiter (---)");
    }
    
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!fmMatch) {
      errors.push("Invalid YAML frontmatter structure");
    } else {
      const fmContent = fmMatch[1];
      
      // Validate required fields
      if (!fmContent.includes(`name:`)) {
        errors.push("Missing 'name' field in frontmatter");
      }
      if (!fmContent.includes(`applyTo`)) {
        errors.push("Missing 'applyTo' field in frontmatter");
      }
    }
    
    // Validate that applyTo globs are reasonable (not empty, not wildcard-only for specific skills)
    if (appliedGlobs.length === 0) {
      appliedGlobs = ["**/*"];
      warnings.push("No applyTo globs specified, defaulting to **/* (matches all files)");
    }
    
    // Check for potentially over-broad patterns that might cause performance issues
    if (appliedGlobs.length > 20) {
      warnings.push(`applyTo has ${appliedGlobs.length} patterns (>20); consider consolidating`);
    }
    
    // Validate that the skill body exists after frontmatter
    if (!fmMatch || fmMatch[0].length >= content.length - 50) {
      warnings.push("Instruction file body appears to be missing or very small");
    }
  } catch (error) {
    errors.push(`Failed to read instruction file: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    filePath,
    skillName,
    appliedGlobs,
  };
}

/** Build Copilot instruction file with telemetry metadata. */
export function buildCopilotInstructionsFileWithTelemetry(
  skillName: string,
  detectGlobs: string[],
  skillMdPath: string,
  deploymentTimestamp?: string
): string {
  const raw = fs.readFileSync(skillMdPath, "utf-8");
  const body = skillBodyWithoutFrontmatter(raw);
  const { description } = parseSkillFrontmatterMeta(raw);
  const applyTo = detectGlobs.length > 0 ? detectGlobs : ["**/*"];
  const timestamp = deploymentTimestamp || new Date().toISOString();
  
  const lines = ["---"];
  if (description) {
    lines.push(`name: "${escapeYamlString(skillName)}"`, `description: "${escapeYamlString(description)}"`);
  }
  
  // Add telemetry metadata for Copilot adoption tracking
  lines.push(
    formatApplyToYaml(applyTo),
    `deployedAt: "${timestamp}"`,
    "---",
    "",
    `# ${skillName}`,
    "",
    "<!-- Copilot Instruction Telemetry: This file was auto-generated by Claude Skills Manager -->",
    "<!-- If this instruction was helpful, please report it to help improve adoption metrics -->",
    "",
    body,
    ""
  );
  return lines.join("\n");
}
