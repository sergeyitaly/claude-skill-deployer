/** Shared skill name extraction from agent skill/instruction file paths. */

const DENYLIST = new Set([
  "claude",
  "cursor",
  "api",
  "claude-api",
  "unknown",
  "base",
  "context",
  "skill",
  "skills",
  "kiro",
  "copilot",
]);

export function isPlausibleSkillName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) && name.length >= 3 && !DENYLIST.has(name);
}

const SKILL_FILE_PATTERNS = [
  /[\\/](?:\.claude|\.cursor|\.kiro)[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.github[\\/]instructions[\\/]([a-z][a-z0-9-]*)\.instructions\.md/i,
];

/** Extract skill name when a path points at a skill package or Copilot instruction file. */
export function skillNameFromFilePath(filePath: string): string | null {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return null;
  }
  for (const pattern of SKILL_FILE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = filePath.match(pattern);
    if (match && isPlausibleSkillName(match[1].toLowerCase())) {
      return match[1].toLowerCase();
    }
  }
  return null;
}
