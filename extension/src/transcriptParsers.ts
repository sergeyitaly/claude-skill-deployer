import * as fs from "node:fs";
import { AgentId } from "./agentOps";

export interface ParsedTranscript {
  agent: AgentId;
  sessionId: string;
  tokens: number;
  skills: string[];
  filePath: string;
}

export interface TranscriptParser {
  agent: AgentId;
  parseFile(filePath: string): ParsedTranscript | null;
}

const SKILL_NAME_RE = /^- ([a-z0-9][a-z0-9-]*):/gm;
const SKILLS_PATH_RE = /[\\/]\.claude[\\/]skills[\\/]([a-z0-9][a-z0-9-]*)/gi;
const CURSOR_SKILLS_PATH_RE = /[\\/]\.cursor[\\/]skills[\\/]([a-z0-9][a-z0-9-]*)/gi;

function sumClaudeUsageLines(content: string): number {
  let total = 0;
  for (const line of content.split("\n")) {
    if (!line.includes('"usage"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        sessionId?: string;
        message?: { usage?: Record<string, number> };
      };
      const u = parsed.message?.usage;
      if (!u) {
        continue;
      }
      total +=
        (u.input_tokens ?? 0) +
        (u.output_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
    } catch {
      // skip
    }
  }
  return total;
}

function extractSessionId(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    try {
      const parsed = JSON.parse(line) as { sessionId?: string };
      if (parsed.sessionId) {
        return parsed.sessionId;
      }
    } catch {
      // skip
    }
  }
  return fallback;
}

function extractSkillsFromContent(content: string): string[] {
  const found = new Set<string>();

  for (const match of content.matchAll(SKILL_NAME_RE)) {
    found.add(match[1]);
  }

  for (const re of [SKILLS_PATH_RE, CURSOR_SKILLS_PATH_RE]) {
    re.lastIndex = 0;
    for (const match of content.matchAll(re)) {
      found.add(match[1]);
    }
  }

  if (content.includes('"type":"skill_listing"')) {
    for (const line of content.split("\n")) {
      if (!line.includes("skill_listing")) {
        continue;
      }
      for (const match of line.matchAll(/- ([a-z0-9][a-z0-9-]*):/g)) {
        found.add(match[1]);
      }
    }
  }

  return [...found].sort();
}

export const claudeParser: TranscriptParser = {
  agent: "claude",
  parseFile(filePath: string): ParsedTranscript | null {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    const tokens = sumClaudeUsageLines(content);
    if (tokens === 0 && content.length < 100) {
      return null;
    }
    const base = pathBasename(filePath, ".jsonl");
    return {
      agent: "claude",
      sessionId: extractSessionId(content, base),
      tokens: tokens || Math.round(content.length / 4),
      skills: extractSkillsFromContent(content),
      filePath,
    };
  },
};

export const cursorParser: TranscriptParser = {
  agent: "cursor",
  parseFile(filePath: string): ParsedTranscript | null {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    let tokens = 0;
    for (const line of content.split("\n")) {
      if (!line.includes("usage")) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          message?: { usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } };
        };
        const u = parsed.message?.usage;
        if (u?.total_tokens) {
          tokens += u.total_tokens;
        } else if (u) {
          tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
      } catch {
        // skip
      }
    }
    if (tokens === 0) {
      tokens = Math.round(content.length / 4);
    }
    const base = pathBasename(filePath, ".jsonl");
    return {
      agent: "cursor",
      sessionId: base,
      tokens,
      skills: extractSkillsFromContent(content),
      filePath,
    };
  },
};

function pathBasename(filePath: string, ext: string): string {
  const name = filePath.split(/[/\\]/).pop() ?? filePath;
  return name.endsWith(ext) ? name.slice(0, -ext.length) : name;
}

export function parserForAgent(agent: AgentId): TranscriptParser | null {
  switch (agent) {
    case "claude":
      return claudeParser;
    case "cursor":
      return cursorParser;
    default:
      return null;
  }
}

export function listTranscriptFiles(root: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  walk(root.replace(/\\/g, "/"));
  return results;
}
