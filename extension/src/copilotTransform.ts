import * as fs from "node:fs";

/** Strip YAML frontmatter and return body markdown. */
export function skillBodyWithoutFrontmatter(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? raw.slice(match[0].length).trim() : raw.trim();
}

/** Convert detect_globs to Copilot applyTo list (YAML array under frontmatter). */
export function buildCopilotInstructionsFile(skillName: string, detectGlobs: string[], skillMdPath: string): string {
  const raw = fs.readFileSync(skillMdPath, "utf-8");
  const body = skillBodyWithoutFrontmatter(raw);
  const applyTo = detectGlobs.length > 0 ? detectGlobs : ["**/*"];
  const lines = ["---", "applyTo:"];
  for (const g of applyTo) {
    lines.push(`  - ${g}`);
  }
  lines.push("---", "", `# ${skillName}`, "", body, "");
  return lines.join("\n");
}
