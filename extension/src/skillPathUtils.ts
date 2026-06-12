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
  /[\\/]\.cursor[\\/]skills-cursor[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.agents[\\/]skills[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]skills_library[\\/]([a-z][a-z0-9-]*)(?:[\\/]SKILL\.md)?/i,
  /[\\/]\.github[\\/]instructions[\\/]([a-z][a-z0-9-]*)\.instructions\.md/i,
];

/** Collect every skill name referenced by known skill/instruction paths in text. */
export function skillNamesFromText(text: string): string[] {
  const names = new Set<string>();
  for (const pattern of SKILL_FILE_PATTERNS) {
    const flags = pattern.flags.includes("i") ? "gi" : "g";
    const global = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(global)) {
      const name = match[1].toLowerCase();
      if (isPlausibleSkillName(name)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

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
