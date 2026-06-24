/** Shared skill name extraction from agent skill/instruction file paths. */

const DENYLIST = new Set([
  // Agent/platform names
  "claude", "cursor", "api", "claude-api", "unknown", "base", "context",
  "skill", "skills", "kiro", "copilot",
  // Common transcript parsing artifacts: single verbs, programming terms, abbreviations
  "run", "runs", "verify", "name", "code", "test", "init", "exec", "call",
  "load", "save", "read", "list", "get", "set", "put", "use", "log",
  "npy", "json", "yaml", "text", "data", "type", "file", "path", "args",
  "true", "false", "null", "none", "self",
  // Package manager / build tool artifacts (transcript parsing captures these as skill names)
  "nnpm", "npm", "npx", "pnpm", "yarn", "bun", "node", "deno",
  "pip", "pip3", "pip2", "conda", "venv", "poetry",
  "make", "rake", "gulp", "grunt",
]);

/** Single-letter prefix followed only by digits — e.g. "n199", "n189", "n379". */
const ARTIFACT_PATTERN = /^[a-z]\d+$/;

export function isPlausibleSkillName(name: string): boolean {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) return false;
  if (name.length < 3) return false;
  if (DENYLIST.has(name)) return false;
  // Reject "n199"-style transcript artifacts (single letter + digits only)
  if (ARTIFACT_PATTERN.test(name)) return false;
  return true;
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
