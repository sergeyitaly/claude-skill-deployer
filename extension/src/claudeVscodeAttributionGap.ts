import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { countV2HookRuns } from "./runsStore";
import { listTranscriptFiles } from "./transcriptParsers";
import { transcriptFileMatchesWorkspace } from "./workspaceTranscripts";

const MIN_TOOL_USES_FOR_GAP = 5;
const DEFAULT_DAYS_BACK = 14;

export interface ClaudeVscodeAttributionGap {
  /** PostToolUse configured but VS Code sessions show tool use without PostToolUse hook fires. */
  detected: boolean;
  /** PreToolUse workaround registered in .claude/settings.json. */
  preToolWorkaroundInstalled: boolean;
  /** v2 hook rows exist — gap may be mitigated even when PostToolUse never logged. */
  mitigated: boolean;
  vscodeSessionCount: number;
  toolUseCount: number;
  postToolUseHookFires: number;
  postToolUseConfigured: boolean;
  summary: string;
  recommendation: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function readSettingsHooks(target: string): { postToolUse: boolean; preToolUse: boolean } {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf-8")
    ) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
    const hasInvoke = (entries: { hooks?: { command?: string }[] }[] | undefined): boolean =>
      (entries ?? []).some((entry) =>
        (entry.hooks ?? []).some((h) =>
          (h.command ?? "").includes("skill-invoke-watch.js") ||
          (h.command ?? "").includes("/hook/skill-invoke")
        )
      );
    return {
      postToolUse: hasInvoke(raw.hooks?.PostToolUse),
      preToolUse: hasInvoke(raw.hooks?.PreToolUse),
    };
  } catch {
    return { postToolUse: false, preToolUse: false };
  }
}

function scanTranscriptContent(content: string): {
  vscodeSession: boolean;
  toolUses: number;
  postToolUseFires: number;
} {
  let vscodeSession = false;
  let toolUses = 0;
  let postToolUseFires = 0;

  if (content.includes('"entrypoint":"claude-vscode"') || content.includes('"entrypoint": "claude-vscode"')) {
    vscodeSession = true;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    if (line.includes('"entrypoint":"claude-vscode"') || line.includes('"entrypoint": "claude-vscode"')) {
      vscodeSession = true;
    }
    if (line.includes('"type":"tool_use"') || line.includes('"type": "tool_use"')) {
      toolUses += 1;
    }
    if (
      line.includes('"type":"hook_success"') ||
      line.includes('"type": "hook_success"')
    ) {
      if (
        line.includes("PostToolUse") ||
        line.includes('"hookEvent":"PostToolUse"') ||
        line.includes('"hookEvent": "PostToolUse"')
      ) {
        postToolUseFires += 1;
      }
    }
  }

  return { vscodeSession, toolUses, postToolUseFires };
}

/** Detect Claude VS Code extension sessions where PostToolUse attribution hooks never fire. */
export function assessClaudeVscodeAttributionGap(
  target: string,
  daysBack = DEFAULT_DAYS_BACK,
  opts?: { claudeTranscriptsRoot?: string }
): ClaudeVscodeAttributionGap {
  const hooks = readSettingsHooks(target);
  const windowStartMs = Date.now() - daysBack * 86_400_000;
  const root = opts?.claudeTranscriptsRoot ?? expandHome("~/.claude/projects");

  let vscodeSessionCount = 0;
  let toolUseCount = 0;
  let postToolUseHookFires = 0;

  for (const file of listTranscriptFiles(root)) {
    if (!transcriptFileMatchesWorkspace(file, target)) {
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < windowStartMs) {
      continue;
    }

    let content = "";
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const scan = scanTranscriptContent(content);
    if (!scan.vscodeSession) {
      continue;
    }
    vscodeSessionCount += 1;
    toolUseCount += scan.toolUses;
    postToolUseHookFires += scan.postToolUseFires;
  }

  const v2Runs = countV2HookRuns(target);
  const preToolWorkaroundInstalled = hooks.preToolUse;
  const mitigated = preToolWorkaroundInstalled && v2Runs > 0;

  const detected =
    hooks.postToolUse &&
    vscodeSessionCount > 0 &&
    toolUseCount >= MIN_TOOL_USES_FOR_GAP &&
    postToolUseHookFires === 0 &&
    !mitigated;

  let summary = "Claude VS Code attribution: no recent VS Code sessions scanned.";
  let recommendation = "";

  if (!hooks.postToolUse) {
    summary = "Attribution PostToolUse hook not configured for Claude.";
    recommendation = "Run Enable Attribution Hooks (v2) from the command palette.";
  } else if (vscodeSessionCount === 0) {
    summary = "No Claude VS Code extension sessions in the attribution window.";
  } else if (toolUseCount < MIN_TOOL_USES_FOR_GAP) {
    summary = `Claude VS Code: ${vscodeSessionCount} session(s), light tool use — gap not assessed yet.`;
  } else if (postToolUseHookFires > 0) {
    summary = `Claude VS Code: PostToolUse attribution hooks firing (${postToolUseHookFires} event(s)).`;
  } else if (mitigated) {
    summary = `Claude VS Code: PostToolUse silent, but PreToolUse workaround logged ${v2Runs} skill invoke(s).`;
    recommendation =
      "PreToolUse workaround is active. For API usage breakdown per invoke, prefer Claude Code CLI.";
  } else if (detected) {
    summary = `Claude VS Code gap: ${toolUseCount} tool use(s) across ${vscodeSessionCount} session(s), zero PostToolUse hook fires.`;
    if (!preToolWorkaroundInstalled) {
      recommendation =
        "PostToolUse hooks do not run in the Claude VS Code extension (anthropics/claude-code#27014). " +
        "Re-sync hooks to install the PreToolUse workaround, or use Claude Code CLI for measured attribution.";
    } else {
      recommendation =
        "PreToolUse workaround is installed but no skill invokes logged yet. " +
        "Ask the agent to Read relevant SKILL.md files, or use Claude Code CLI.";
    }
  }

  return {
    detected,
    preToolWorkaroundInstalled,
    mitigated,
    vscodeSessionCount,
    toolUseCount,
    postToolUseHookFires,
    postToolUseConfigured: hooks.postToolUse,
    summary,
    recommendation,
  };
}
