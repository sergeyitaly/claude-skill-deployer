import * as fs from "node:fs";
import * as path from "node:path";
import { AgentId, listWorkspaceSkillsForAgent, loadAgentsManifest } from "./agentOps";
import { detectHostAgentId, hostAgentLabel } from "./agentSkillProfiles";
import {
  installSkillsToWorkspace,
  loadManifest,
  markSkillAsPersonalLocal,
} from "./skillOps";
import { ensureLearningDir, listInstalledSkills } from "./usageStats";

const LEARNING_MIRROR_FILES = [
  "task-skill-proposals.json",
  "task-active-skills.json",
  "task-drift-prompt.json",
  "session-skill-apply-request.json",
  "profile-init-request.json",
] as const;

export interface HostBootstrapResult {
  host: AgentId;
  importedSkills: string[];
  importedLearning: string[];
}

/** Ensure canonical store exists even when the user never opened Claude Code in this repo. */
export function ensureCanonicalWorkspaceLayout(target: string): void {
  ensureLearningDir(target);
  fs.mkdirSync(path.join(target, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(target, ".claude", "hooks"), { recursive: true });
}

function hostLearningDir(target: string, host: AgentId, libraryDir: string): string | undefined {
  const agentsFile = path.join(libraryDir, "agents.json");
  if (!fs.existsSync(agentsFile)) {
    return undefined;
  }
  const learningRel = loadAgentsManifest(libraryDir).agents[host]?.learningDir;
  if (!learningRel) {
    return undefined;
  }
  return path.join(target, learningRel);
}

/** Pull missing skills from the host IDE mirror into `.claude/skills/` (canonical). */
export function importHostSkillsToCanonical(
  libraryDir: string,
  target: string,
  host: AgentId = detectHostAgentId()
): string[] {
  if (host === "claude") {
    return [];
  }

  const manifestPath = path.join(libraryDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  const manifest = loadManifest(libraryDir);
  const hostSkills = listWorkspaceSkillsForAgent(target, host, libraryDir).filter((name) => name in manifest.skills);
  if (hostSkills.length === 0) {
    return [];
  }

  const canonical = new Set(listInstalledSkills(target));
  const toImport = hostSkills.filter((name) => !canonical.has(name));
  if (toImport.length === 0) {
    return [];
  }

  const results = installSkillsToWorkspace(libraryDir, target, toImport, { force: false, dryRun: false });
  const imported = results
    .filter((r) => r.status === "installed" || r.status === "skipped-exists")
    .map((r) => r.skill);

  for (const skill of imported) {
    markSkillAsPersonalLocal(target, skill);
  }
  return imported;
}

/** Pull learning artifacts from host agent dir when canonical copies are missing. */
export function importHostLearningToCanonical(
  target: string,
  libraryDir: string,
  host: AgentId = detectHostAgentId()
): string[] {
  const sourceDir = hostLearningDir(target, host, libraryDir);
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return [];
  }

  ensureCanonicalWorkspaceLayout(target);
  const destDir = path.join(target, ".claude", "learning");
  const imported: string[] = [];

  for (const file of LEARNING_MIRROR_FILES) {
    const src = path.join(sourceDir, file);
    const dst = path.join(destDir, file);
    if (!fs.existsSync(src) || fs.existsSync(dst)) {
      continue;
    }
    fs.copyFileSync(src, dst);
    imported.push(file);
  }
  return imported;
}

/**
 * Host-first entry: user may open Cursor/Kiro/Copilot before Claude Code.
 * Canonical state lives under `.claude/`; host mirrors are imported when canonical is empty.
 */
export function bootstrapWorkspaceForHostAgent(
  libraryDir: string,
  target: string
): HostBootstrapResult {
  ensureCanonicalWorkspaceLayout(target);
  const host = detectHostAgentId();
  const importedSkills = importHostSkillsToCanonical(libraryDir, target, host);
  const importedLearning = importHostLearningToCanonical(target, libraryDir, host);
  return { host, importedSkills, importedLearning };
}

export function formatHostBootstrapLog(result: HostBootstrapResult): string | undefined {
  const parts: string[] = [];
  if (result.importedSkills.length > 0) {
    parts.push(`imported ${result.importedSkills.length} skill(s) from ${hostAgentLabel(result.host)}`);
  }
  if (result.importedLearning.length > 0) {
    parts.push(`imported learning: ${result.importedLearning.join(", ")}`);
  }
  return parts.length > 0 ? `Host-first bootstrap (${hostAgentLabel(result.host)}): ${parts.join("; ")}.` : undefined;
}
