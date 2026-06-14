import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildCopilotInstructionsFile,
  CopilotSkillEntry,
  writeCopilotBootstrap,
} from "./copilotTransform";
import { parseSkillFrontmatter } from "./skillLint";
import { isFeatureEnabled } from "./featureFlags";
import {
  copySkill,
  discoverBundledSkills,
  detectRelevantSkills,
  globalSkillsDir,
  InstallResult,
  listEffectiveEnabledSkills,
  loadManifest,
  Manifest,
  readSkillOverrides,
  removeSkill,
  settingsLocalPath,
} from "./skillOps";
import { computeCreditUsageFromRoots, mergeHookModelsIntoAgentRows, ModelUsage } from "./usageCost";
import { readCachedCreditUsageFromRoots } from "./transcriptUsageIndex";
import { fileContentHash, shouldCopyPath, stringContentHash } from "./fileHash";
import { yieldToEventLoop } from "./eventLoop";

export type AgentId = "claude" | "cursor" | "kiro" | "copilot";

export interface AgentDefinition {
  displayName: string;
  format: "skill-md" | "copilot-instructions";
  /** Relative to homedir for global, relative to workspace root for workspace. */
  globalDir: string;
  workspaceDir: string;
  learningDir: string | null;
  supportsGlobal: boolean;
  supportsWorkspace: boolean;
  supportsBranchProfiles: boolean;
  supportsUsageTranscripts: boolean;
  transcriptRoots: string[];
  /** PostToolUse / postToolUse hook for skill-invoke attribution (Attribution v2). */
  supportsAttributionHooks?: boolean;
}

export interface AgentsManifest {
  agents: Record<AgentId, AgentDefinition>;
}

export interface AgentInstallResult {
  agent: AgentId;
  skill: string;
  status: InstallResult["status"] | "source-missing" | "written";
  reason?: string;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function loadAgentsManifest(libraryDir: string): AgentsManifest {
  const file = path.join(libraryDir, "agents.json");
  if (!fs.existsSync(file)) {
    throw new Error(`agents.json not found: ${file}`);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as AgentsManifest;
    if (!parsed.agents || typeof parsed.agents !== "object") {
      throw new Error("agents.json missing agents map");
    }
    return parsed;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

export function enabledAgents(libraryDir: string): AgentId[] {
  const manifest = loadAgentsManifest(libraryDir);
  const configured = vscode.workspace.getConfiguration("claudeSkills.agents").get<AgentId[]>("enabled", [
    "claude",
    "cursor",
    "kiro",
    "copilot",
  ]);
  return configured.filter((id) => id in manifest.agents);
}

/** True when multi-agent feature is on and workspace installs fan out to all enabled agents. */
export function shouldSyncWorkspaceToAll(): boolean {
  if (!isFeatureEnabled("multiAgent")) {
    return false;
  }
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncWorkspaceToAll", true);
}

/** True when multi-agent feature is on and global installs fan out to all enabled agents. */
export function shouldSyncGlobalToAll(): boolean {
  if (!isFeatureEnabled("multiAgent")) {
    return false;
  }
  return vscode.workspace.getConfiguration("claudeSkills.agents").get<boolean>("syncGlobalToAll", true);
}

function resolveSkillSourceRoot(skillName: string, sourceRoot: string, libraryDir: string): string | undefined {
  if (fs.existsSync(path.join(sourceRoot, skillName, "SKILL.md"))) {
    return sourceRoot;
  }
  if (fs.existsSync(path.join(libraryDir, skillName, "SKILL.md"))) {
    return libraryDir;
  }
  return undefined;
}

function removeSkillFromAgent(agent: AgentDefinition, destRoot: string, skillName: string): boolean {
  if (agent.format === "skill-md") {
    return removeSkill(destRoot, skillName);
  }
  const file = path.join(destRoot, `${skillName}.instructions.md`);
  if (!fs.existsSync(file)) {
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}

function globalDirFor(agent: AgentDefinition): string {
  if (agent.globalDir.startsWith("~/")) {
    return expandHome(agent.globalDir);
  }
  return path.join(os.homedir(), agent.globalDir);
}

function workspaceDirFor(target: string, agent: AgentDefinition): string {
  return path.join(target, agent.workspaceDir);
}

function writeCopilotInstruction(
  skillName: string,
  sourceSkillMd: string,
  detectGlobs: string[],
  destFile: string,
  force: boolean,
  dryRun: boolean
): AgentInstallResult["status"] {
  const content = buildCopilotInstructionsFile(skillName, detectGlobs, sourceSkillMd);
  if (fs.existsSync(destFile) && !force) {
    const existing = fileContentHash(destFile);
    if (existing && existing === stringContentHash(content)) {
      return "skipped-exists";
    }
  }
  if (dryRun) {
    return "would-install";
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, content, "utf-8");
  return "written";
}

function installSkillToAgent(
  agentId: AgentId,
  agent: AgentDefinition,
  skillName: string,
  libraryDir: string,
  manifest: Manifest,
  destRoot: string,
  force: boolean,
  dryRun: boolean
): AgentInstallResult {
  const bundledSkillMd = path.join(libraryDir, skillName, "SKILL.md");
  if (!fs.existsSync(bundledSkillMd)) {
    return { agent: agentId, skill: skillName, status: "source-missing" };
  }

  if (agent.format === "skill-md") {
    const status = copySkill(skillName, libraryDir, destRoot, force, dryRun);
    return { agent: agentId, skill: skillName, status };
  }

  const detectGlobs = manifest.skills[skillName]?.detect_globs ?? ["**/*"];
  const destFile = path.join(destRoot, `${skillName}.instructions.md`);
  const status = writeCopilotInstruction(skillName, bundledSkillMd, detectGlobs, destFile, force, dryRun);
  return { agent: agentId, skill: skillName, status };
}

/** Copy the bundled library into each enabled agent's global skills/instructions dir. */
export function installLibraryToAllAgents(
  libraryDir: string,
  force: boolean,
  dryRun: boolean,
  agentIds?: AgentId[]
): AgentInstallResult[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const manifest = loadManifest(libraryDir);
  const ids = agentIds ?? enabledAgents(libraryDir);
  const skills = discoverBundledSkills(libraryDir);
  const results: AgentInstallResult[] = [];

  for (const agentId of ids) {
    const agent = agentsManifest.agents[agentId];
    if (!agent.supportsGlobal) {
      continue;
    }
    const destRoot = globalDirFor(agent);
    for (const skill of skills) {
      results.push(installSkillToAgent(agentId, agent, skill, libraryDir, manifest, destRoot, force, dryRun));
    }
  }
  return results;
}

/** Install detected (or all) skills into each enabled agent's workspace paths. */
export function generateForAllAgents(
  libraryDir: string,
  target: string,
  opts: { all: boolean; force: boolean; dryRun: boolean },
  agentIds?: AgentId[]
): AgentInstallResult[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const manifest = loadManifest(libraryDir);
  const ids = agentIds ?? enabledAgents(libraryDir);
  const detected = opts.all
    ? Object.fromEntries(Object.keys(manifest.skills).map((name) => [name, ["--all"]]))
    : detectRelevantSkills(target, manifest);

  const results: AgentInstallResult[] = [];
  for (const agentId of ids) {
    const agent = agentsManifest.agents[agentId];
    if (!agent.supportsWorkspace) {
      continue;
    }
    const destRoot = workspaceDirFor(target, agent);
    for (const [skillName, matched] of Object.entries(detected)) {
      const r = installSkillToAgent(agentId, agent, skillName, libraryDir, manifest, destRoot, opts.force, opts.dryRun);
      results.push({ ...r, reason: matched.join(", ") });
    }
  }
  return results;
}

/** Install one skill into every enabled agent workspace path (.claude, .cursor, .kiro, .github/instructions). */
export function installSkillToAllWorkspaceAgents(
  libraryDir: string,
  target: string,
  skillName: string,
  sourceRoot: string,
  force: boolean,
  dryRun: boolean,
  agentIds?: AgentId[]
): AgentInstallResult[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const manifest = loadManifest(libraryDir);
  const resolvedSource = resolveSkillSourceRoot(skillName, sourceRoot, libraryDir);
  const results: AgentInstallResult[] = [];

  for (const agentId of agentIds ?? enabledAgents(libraryDir)) {
    const agent = agentsManifest.agents[agentId];
    if (!agent.supportsWorkspace) {
      continue;
    }
    const destRoot = workspaceDirFor(target, agent);
    if (!resolvedSource) {
      results.push({ agent: agentId, skill: skillName, status: "source-missing" });
      continue;
    }
    if (agent.format === "skill-md") {
      results.push({
        agent: agentId,
        skill: skillName,
        status: copySkill(skillName, resolvedSource, destRoot, force, dryRun, { libraryDir }),
      });
      continue;
    }
    const detectGlobs = manifest.skills[skillName]?.detect_globs ?? ["**/*"];
    const destFile = path.join(destRoot, `${skillName}.instructions.md`);
    const status = writeCopilotInstruction(
      skillName,
      path.join(resolvedSource, skillName, "SKILL.md"),
      detectGlobs,
      destFile,
      force,
      dryRun
    );
    results.push({ agent: agentId, skill: skillName, status });
  }
  return results;
}

/** Remove one skill from every enabled agent workspace path. */
export function removeSkillFromAllWorkspaceAgents(
  libraryDir: string,
  target: string,
  skillName: string,
  agentIds?: AgentId[]
): { agent: AgentId; removed: boolean }[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const out: { agent: AgentId; removed: boolean }[] = [];
  for (const agentId of agentIds ?? enabledAgents(libraryDir)) {
    const agent = agentsManifest.agents[agentId];
    if (!agent.supportsWorkspace) {
      continue;
    }
    const destRoot = workspaceDirFor(target, agent);
    out.push({ agent: agentId, removed: removeSkillFromAgent(agent, destRoot, skillName) });
  }
  return out;
}

function listSkillMdSkillsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
}

function listCopilotInstructionsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".instructions.md"))
    .map((e) => e.name.replace(/\.instructions\.md$/, ""));
}

function listAgentWorkspaceSkills(target: string, agent: AgentDefinition): string[] {
  const destRoot = workspaceDirFor(target, agent);
  return agent.format === "skill-md" ? listSkillMdSkillsInDir(destRoot) : listCopilotInstructionsInDir(destRoot);
}

export interface AgentMirrorGap {
  agent: AgentId;
  missing: string[];
}

/** Skills present in .claude/skills but missing from another agent's workspace mirror. */
export function missingAgentMirrorSkills(target: string, libraryDir: string): AgentMirrorGap[] {
  if (!shouldSyncWorkspaceToAll()) {
    return [];
  }
  const effective = listEffectiveEnabledSkills(target);
  if (effective.length === 0) {
    return [];
  }
  const agentsManifest = loadAgentsManifest(libraryDir);
  const gaps: AgentMirrorGap[] = [];

  for (const agentId of enabledAgents(libraryDir)) {
    if (agentId === "claude") {
      continue;
    }
    const agent = agentsManifest.agents[agentId];
    if (!agent.supportsWorkspace) {
      continue;
    }
    const destRoot = workspaceDirFor(target, agent);
    const missing: string[] = [];
    for (const skill of effective) {
      if (agent.format === "skill-md") {
        if (!fs.existsSync(path.join(destRoot, skill, "SKILL.md"))) {
          missing.push(skill);
        }
      } else if (!fs.existsSync(path.join(destRoot, `${skill}.instructions.md`))) {
        missing.push(skill);
      }
    }
    if (missing.length > 0) {
      gaps.push({ agent: agentId, missing });
    }
  }
  return gaps;
}

export function agentMirrorsNeedSync(target: string, libraryDir: string): boolean {
  if (missingAgentMirrorSkills(target, libraryDir).length > 0) {
    return true;
  }
  return hasStaleAgentMirrorSkills(target, libraryDir);
}

/** Agent mirrors present for skills the user has disabled or removed from the effective set. */
export function hasStaleAgentMirrorSkills(target: string, libraryDir: string): boolean {
  if (!shouldSyncWorkspaceToAll()) {
    return false;
  }
  const effective = new Set(listEffectiveEnabledSkills(target));
  const agentsManifest = loadAgentsManifest(libraryDir);

  for (const agentId of enabledAgents(libraryDir)) {
    if (agentId === "claude") {
      continue;
    }
    const agent = agentsManifest.agents[agentId];
    if (!agent.supportsWorkspace) {
      continue;
    }
    for (const skillName of listAgentWorkspaceSkills(target, agent)) {
      if (!effective.has(skillName)) {
        return true;
      }
    }
  }
  return false;
}

function resolveWorkspaceSkillSource(
  target: string,
  libraryDir: string,
  skillName: string,
  claudeDir: string,
  globalDir: string
): string {
  if (fs.existsSync(path.join(claudeDir, skillName, "SKILL.md"))) {
    return claudeDir;
  }
  if (fs.existsSync(path.join(globalDir, skillName, "SKILL.md"))) {
    return globalDir;
  }
  return libraryDir;
}

const lastSyncFingerprint = new Map<string, string>();

/** Stable structural fingerprint — sorted skills, overrides, and SKILL.md content hashes only. */
export function buildWorkspaceSyncFingerprint(target: string): string {
  const skills = [...listEffectiveEnabledSkills(target)].sort();
  const rawOverrides = readSkillOverrides(target);
  const overrides: Record<string, string> = {};
  for (const key of Object.keys(rawOverrides).sort()) {
    overrides[key] = rawOverrides[key];
  }
  const versions: Record<string, string> = {};
  const claudeDir = path.join(target, ".claude", "skills");
  for (const name of skills) {
    const skillMd = path.join(claudeDir, name, "SKILL.md");
    versions[name] = fs.existsSync(skillMd) ? fileContentHash(skillMd) ?? "missing" : "missing";
  }
  return stringContentHash(JSON.stringify({ skills, overrides, versions }));
}

function workspaceSyncFingerprint(target: string): string {
  return buildWorkspaceSyncFingerprint(target);
}

export interface WorkspaceAgentSyncOptions {
  force?: boolean;
  /** Sync only these skills (agent-diff). Omit for full workspace mirror. */
  skillNames?: string[];
  /** Limit sync to specific agents. Omit for all enabled non-Claude agents. */
  agentIds?: AgentId[];
}

/** Clear after skill install/remove/override so the next sync is not skipped. */
export function invalidateWorkspaceSyncFingerprint(target?: string): void {
  if (target) {
    lastSyncFingerprint.delete(path.resolve(target));
    return;
  }
  lastSyncFingerprint.clear();
}

/** Early no-op: agent mirrors already match the stable workspace fingerprint. */
export function wouldSkipAgentMirrorSync(
  libraryDir: string,
  target: string,
  opts?: { force?: boolean; skillNames?: string[] }
): boolean {
  if (!shouldSyncWorkspaceToAll()) {
    return true;
  }
  if (opts?.force) {
    return false;
  }
  if ((opts?.skillNames?.length ?? 0) > 0) {
    return false;
  }
  if (agentMirrorsNeedSync(target, libraryDir)) {
    return false;
  }
  const fp = workspaceSyncFingerprint(target);
  return lastSyncFingerprint.get(path.resolve(target)) === fp;
}

/**
 * Mirror the user's effective workspace skill set to Cursor, Kiro, Copilot, etc.
 * Uses skills enabled for you (.claude/skills minus skillOverrides "off").
 * .claude/skills remains the file source of truth; other agents receive copies.
 */
function syncWorkspaceAgentSkills(
  libraryDir: string,
  target: string,
  agentId: AgentId,
  opts: {
    partial: boolean;
    force: boolean;
    effective: Set<string>;
    skillsToTouch: string[];
    claudeDir: string;
    globalDir: string;
  }
): AgentInstallResult[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const agent = agentsManifest.agents[agentId];
  if (!agent.supportsWorkspace) {
    return [];
  }
  const results: AgentInstallResult[] = [];
  const destRoot = workspaceDirFor(target, agent);

  if (!opts.partial) {
    for (const skillName of listAgentWorkspaceSkills(target, agent)) {
      if (!opts.effective.has(skillName)) {
        removeSkillFromAgent(agent, destRoot, skillName);
      }
    }
  }

  for (const skillName of opts.skillsToTouch) {
    if (!opts.effective.has(skillName)) {
      removeSkillFromAgent(agent, destRoot, skillName);
      continue;
    }
    const sourceRoot = resolveWorkspaceSkillSource(
      target,
      libraryDir,
      skillName,
      opts.claudeDir,
      opts.globalDir
    );
    for (const r of installSkillToAllWorkspaceAgents(libraryDir, target, skillName, sourceRoot, opts.force, false, [
      agentId,
    ])) {
      if (r.status === "installed" || r.status === "written" || r.status === "skipped-exists") {
        results.push(r);
      }
    }
  }
  return results;
}

export function syncWorkspaceSkillsToAllAgents(
  libraryDir: string,
  target: string,
  opts?: WorkspaceAgentSyncOptions
): AgentInstallResult[] {
  if (!shouldSyncWorkspaceToAll()) {
    return [];
  }
  const force = opts?.force ?? false;
  const partial = (opts?.skillNames?.length ?? 0) > 0;
  const key = path.resolve(target);
  const fp = workspaceSyncFingerprint(target);
  if (!force && !partial && !agentMirrorsNeedSync(target, libraryDir) && lastSyncFingerprint.get(key) === fp) {
    return [];
  }
  const globalDir = globalSkillsDir();
  const claudeDir = path.join(target, ".claude", "skills");
  const effective = new Set(listEffectiveEnabledSkills(target));
  const agentLoop = (opts?.agentIds ?? enabledAgents(libraryDir)).filter((id) => id !== "claude");
  const skillsToTouch = opts?.skillNames ?? [...effective];
  const shared = { partial, force, effective, skillsToTouch, claudeDir, globalDir };

  const results = agentLoop.flatMap((agentId) =>
    syncWorkspaceAgentSkills(libraryDir, target, agentId, shared)
  );

  if (enabledAgents(libraryDir).includes("copilot") && (!partial || skillsToTouch.length > 0)) {
    syncCopilotBootstrap(target, libraryDir);
  }

  if (!partial) {
    lastSyncFingerprint.set(key, fp);
  }
  return results;
}

/** Fan-out per agent on separate event-loop turns — yields between agents for UI responsiveness. */
export async function syncWorkspaceSkillsToAllAgentsAsync(
  libraryDir: string,
  target: string,
  opts?: WorkspaceAgentSyncOptions
): Promise<AgentInstallResult[]> {
  if (!shouldSyncWorkspaceToAll()) {
    return [];
  }
  const force = opts?.force ?? false;
  const partial = (opts?.skillNames?.length ?? 0) > 0;
  const key = path.resolve(target);
  const fp = workspaceSyncFingerprint(target);
  if (!force && !partial && !agentMirrorsNeedSync(target, libraryDir) && lastSyncFingerprint.get(key) === fp) {
    return [];
  }
  const globalDir = globalSkillsDir();
  const claudeDir = path.join(target, ".claude", "skills");
  const effective = new Set(listEffectiveEnabledSkills(target));
  const agentLoop = (opts?.agentIds ?? enabledAgents(libraryDir)).filter((id) => id !== "claude");
  const skillsToTouch = opts?.skillNames ?? [...effective];
  const shared = { partial, force, effective, skillsToTouch, claudeDir, globalDir };

  const results: AgentInstallResult[] = [];
  for (const agentId of agentLoop) {
    results.push(...syncWorkspaceAgentSkills(libraryDir, target, agentId, shared));
    await yieldToEventLoop();
  }

  if (enabledAgents(libraryDir).includes("copilot") && (!partial || skillsToTouch.length > 0)) {
    await yieldToEventLoop();
    syncCopilotBootstrap(target, libraryDir);
  }

  if (!partial) {
    lastSyncFingerprint.set(key, fp);
  }
  return results;
}

/** Write .github/copilot-instructions.md index for native Copilot agent mode. */
export function syncCopilotBootstrap(target: string, libraryDir: string): string | undefined {
  if (!enabledAgents(libraryDir).includes("copilot")) {
    return undefined;
  }
  const manifest = loadManifest(libraryDir);
  const effective = listEffectiveEnabledSkills(target);
  const entries: CopilotSkillEntry[] = [];

  for (const name of effective) {
    const skillMd = path.join(target, ".claude", "skills", name, "SKILL.md");
    const bundledMd = path.join(libraryDir, name, "SKILL.md");
    const mdPath = fs.existsSync(skillMd) ? skillMd : bundledMd;
    if (!fs.existsSync(mdPath)) {
      continue;
    }
    const raw = fs.readFileSync(mdPath, "utf-8");
    entries.push({
      name,
      detectGlobs: manifest.skills[name]?.detect_globs ?? ["**/*"],
      description: parseSkillFrontmatter(raw)?.description,
    });
  }

  if (entries.length === 0) {
    return undefined;
  }
  return writeCopilotBootstrap(target, entries);
}

/** Mirror learning artifacts (reports, budget, branch profiles) to other agents' learning dirs. */
export function mirrorLearningArtifacts(target: string, libraryDir: string): string[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const ids = enabledAgents(libraryDir).filter((id) => id !== "claude");
  const sourceDir = path.join(target, ".claude", "learning");
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  const skipMirror = new Set([
    "cost-attribution.json",
    "skill-invoke-state.json",
    "attribution-collector-state.json",
    "runs.jsonl",
    "skill-feedback.jsonl",
  ]);
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => (f.endsWith(".md") || f.endsWith(".json")) && !skipMirror.has(f));
  const mirrored: string[] = [];

  for (const agentId of ids) {
    const learningRel = agentsManifest.agents[agentId].learningDir;
    if (!learningRel) {
      continue;
    }
    const destDir = path.join(target, learningRel);
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of files) {
      const src = path.join(sourceDir, file);
      const dst = path.join(destDir, file);
      if (!shouldCopyPath(src, dst)) {
        continue;
      }
      fs.copyFileSync(src, dst);
      mirrored.push(`${agentId}:${file}`);
    }
  }
  return mirrored;
}

export function formatAgentInstallSummary(results: AgentInstallResult[]): string {
  const byAgent = new Map<AgentId, AgentInstallResult[]>();
  for (const r of results) {
    const list = byAgent.get(r.agent) ?? [];
    list.push(r);
    byAgent.set(r.agent, list);
  }

  const lines: string[] = ["## Multi-agent install summary", ""];
  for (const [agent, list] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const installed = list.filter((r) => r.status === "installed" || r.status === "written").length;
    const skipped = list.filter((r) => r.status === "skipped-exists").length;
    lines.push(`### ${agent} (${installed} installed, ${skipped} skipped)`);
    for (const r of list) {
      const reason = r.reason ? ` (${r.reason})` : "";
      lines.push(`- ${r.skill}: ${r.status}${reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Union transcript roots from enabled agents that support usage reporting. */
export function enabledTranscriptRoots(libraryDir: string): string[] {
  const manifest = loadAgentsManifest(libraryDir);
  const roots = new Set<string>();
  for (const id of enabledAgents(libraryDir)) {
    const agent = manifest.agents[id];
    if (!agent.supportsUsageTranscripts) {
      continue;
    }
    for (const root of agent.transcriptRoots) {
      roots.add(root);
    }
  }
  return [...roots];
}

export function computeEnabledAgentsCreditUsage(libraryDir: string, daysBack = 14, workspaceTarget?: string) {
  const roots = enabledTranscriptRoots(libraryDir);
  if (roots.length === 0) {
    return computeCreditUsageFromRoots([], daysBack);
  }
  return readCachedCreditUsageFromRoots(roots, daysBack, workspaceTarget);
}

export interface AgentCreditRow {
  agent: AgentId;
  displayName: string;
  tokens: number;
  cost: number;
  sessions: number;
  /** False when the agent has no session transcript roots (e.g. Copilot). */
  transcriptTracked: boolean;
  /** Token/cost breakdown by model id from session transcripts (last N days). */
  models: ModelUsage[];
}

/** Per-agent token/cost estimate from each agent's transcript folders (last N days). */
export function computePerAgentCreditUsage(
  libraryDir: string,
  daysBack = 14,
  workspaceTarget?: string
): AgentCreditRow[] {
  const manifest = loadAgentsManifest(libraryDir);
  const rows = enabledAgents(libraryDir).map((id) => {
    const def = manifest.agents[id];
    const tracked = Boolean(def.supportsUsageTranscripts && def.transcriptRoots.length > 0);
    if (!tracked) {
      return {
        agent: id,
        displayName: def.displayName,
        tokens: 0,
        cost: 0,
        sessions: 0,
        transcriptTracked: false,
        models: [],
      };
    }
    const summary = readCachedCreditUsageFromRoots(def.transcriptRoots, daysBack, workspaceTarget);
    return {
      agent: id,
      displayName: def.displayName,
      tokens: summary.totalTokens,
      cost: summary.totalCost,
      sessions: summary.sessionCount,
      transcriptTracked: true,
      models: summary.byModel,
    };
  });
  return mergeHookModelsIntoAgentRows(rows, workspaceTarget, daysBack);
}

export function agentCapabilityLines(libraryDir: string): string[] {
  const manifest = loadAgentsManifest(libraryDir);
  return enabledAgents(libraryDir).map((id) => {
    const a = manifest.agents[id];
    const bits = [
      a.format,
      a.supportsGlobal ? "global" : null,
      a.supportsWorkspace ? "workspace" : null,
      a.supportsUsageTranscripts ? "usage-transcripts" : null,
      a.supportsBranchProfiles ? "branch-profiles" : null,
    ].filter(Boolean);
    return `- **${a.displayName}** (\`${id}\`): ${bits.join(", ")}`;
  });
}
