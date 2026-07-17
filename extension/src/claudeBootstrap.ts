import { upsertClaudeMdBlock } from "./mcpForce";

export interface ClaudeSkillEntry {
  name: string;
  detectGlobs: string[];
  description?: string;
}

const SKILLS_BLOCK_START = "<!-- claude-skills-manager:installed-skills -->";
const SKILLS_BLOCK_END = "<!-- /claude-skills-manager:installed-skills -->";

/**
 * Unlike copilotTransform.ts's Copilot bootstrap, Claude Code natively discovers and loads
 * .claude/skills/*\/SKILL.md on its own — this block is not required for that to work. It
 * exists purely as a human-readable summary of what's installed and why, for parity with
 * what Copilot (which has no native skill system) already gets unconditionally.
 */
export function buildClaudeSkillsBootstrapBlock(entries: ClaudeSkillEntry[]): string {
  const lines = [
    SKILLS_BLOCK_START,
    "## Installed Claude Skills",
    "",
    "Claude Code discovers and loads skills under `.claude/skills/` automatically — nothing here needs to be read for that to work. This table is kept up to date purely as a human-readable summary of what's installed and why.",
    "",
    "| Skill | Detected via | Description |",
    "|---|---|---|",
  ];

  for (const s of entries) {
    const globs = s.detectGlobs.length > 0 ? s.detectGlobs.join(", ") : "**/*";
    const description = (s.description ?? "").replace(/\|/g, "\\|");
    lines.push(`| ${s.name} | \`${globs}\` | ${description} |`);
  }

  lines.push("", SKILLS_BLOCK_END);
  return lines.join("\n");
}

/** Writes/refreshes the installed-skills summary block in <target>/CLAUDE.md. A no-op when
 * there are no entries, so a workspace with nothing installed yet doesn't get an empty
 * table (or, on first run, an otherwise-unnecessary CLAUDE.md). */
export function syncClaudeSkillsBootstrap(
  target: string,
  entries: ClaudeSkillEntry[]
): { ok: true } | { ok: false; reason: string } {
  if (entries.length === 0) {
    return { ok: true };
  }
  return upsertClaudeMdBlock(target, SKILLS_BLOCK_START, SKILLS_BLOCK_END, buildClaudeSkillsBootstrapBlock(entries));
}
