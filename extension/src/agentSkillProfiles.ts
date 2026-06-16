import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentId } from "./agentOps";
import {
  ApplyProfileResult,
  applyBranchProfile,
  BranchSkillProfile,
  getCurrentBranch,
  getGitRepository,
  repoKeyFor,
} from "./branchProfiles";
import { isFeatureEnabled } from "./featureFlags";
import {
  listEffectiveEnabledSkills,
  readSkillOverrides,
  SkillOverrideValue,
} from "./skillOps";

export const AGENT_SKILL_PROFILES_PATH = path.join(
  os.homedir(),
  ".claude",
  "learning",
  "agent-skill-profiles.json"
);

export interface AgentSkillSet {
  agent: AgentId;
  branch: string;
  skills: string[];
  skillOverrides: Record<string, SkillOverrideValue>;
  updatedAt: string;
  workspacePath: string;
  remoteUrl?: string;
}

interface BranchAgentSets {
  sets: Partial<Record<AgentId, AgentSkillSet>>;
  lastActiveAgent?: AgentId;
}

interface RepoAgentProfiles {
  workspacePath: string;
  remoteUrl?: string;
  branches: Record<string, BranchAgentSets>;
}

interface AgentSkillProfilesStore {
  version: 1;
  repos: Record<string, RepoAgentProfiles>;
}

const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude Code",
  cursor: "Cursor IDE",
  kiro: "Kiro IDE",
  copilot: "VS Code (Copilot)",
};

function readStore(): AgentSkillProfilesStore {
  if (!fs.existsSync(AGENT_SKILL_PROFILES_PATH)) {
    return { version: 1, repos: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENT_SKILL_PROFILES_PATH, "utf-8")) as AgentSkillProfilesStore;
    return { version: 1, repos: parsed.repos ?? {} };
  } catch {
    try {
      fs.renameSync(AGENT_SKILL_PROFILES_PATH, `${AGENT_SKILL_PROFILES_PATH}.corrupt-${Date.now()}`);
    } catch {
      // best-effort
    }
    return { version: 1, repos: {} };
  }
}

function writeStore(store: AgentSkillProfilesStore): void {
  const dir = path.dirname(AGENT_SKILL_PROFILES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.agent-skill-profiles.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, AGENT_SKILL_PROFILES_PATH);
}

function originRemoteUrl(repo: NonNullable<ReturnType<typeof getGitRepository>>): string | undefined {
  const origin = repo.state.remotes.find((r) => r.name === "origin");
  return origin?.fetchUrl ?? origin?.pushUrl;
}

export function agentProfilesFeatureActive(): boolean {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.agentProfiles");
  if (!cfg.get<boolean>("enabled", true)) {
    return false;
  }
  if (isFeatureEnabled("multiAgent")) {
    return true;
  }
  // Host-first: per-IDE skill sets still apply when the extension runs in Cursor/Kiro/VS Code.
  return detectHostAgentId() !== "claude";
}

function agentProfilesEnabled(): boolean {
  return agentProfilesFeatureActive();
}

function autoApplyOnActivate(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agentProfiles").get<boolean>("autoApplyOnActivate", true);
}

function saveOnBranchProfileSave(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.agentProfiles").get<boolean>("saveOnBranchProfileSave", true);
}

/** Map the running editor to the agent id used for skill-set storage. */
export function detectHostAgentId(): AgentId {
  const app = (vscode.env?.appName || "").toLowerCase();
  if (app.includes("cursor")) {
    return "cursor";
  }
  if (app.includes("kiro")) {
    return "kiro";
  }
  const override = vscode.workspace
    .getConfiguration("claudeSkills.agentProfiles")
    .get<AgentId>("hostAgentOverride");
  if (override) {
    return override;
  }
  const vscodeAgent = vscode.workspace
    .getConfiguration("claudeSkills.agentProfiles")
    .get<AgentId>("vscodeAgent", "copilot");
  return vscodeAgent === "claude" ? "claude" : "copilot";
}

export function hostAgentLabel(agent: AgentId = detectHostAgentId()): string {
  return AGENT_LABELS[agent];
}

/** Workspace mirror path for the host IDE's skill layout. */
export function hostAgentMirrorDir(agent: AgentId): string {
  switch (agent) {
    case "cursor":
      return ".cursor/skills/";
    case "kiro":
      return ".kiro/skills/";
    case "copilot":
      return ".github/instructions/";
    default:
      return ".claude/skills/";
  }
}

export function formatHostSkillSetActiveMessage(agent: AgentId, branch: string, skillCount: number): string {
  return (
    `IDE skill set (${hostAgentLabel(agent)}) already active for \`${branch}\` (${skillCount} skill(s); ` +
    `source: .claude/skills → ${hostAgentMirrorDir(agent)}).`
  );
}

export function formatHostSkillSetAppliedMessage(
  agent: AgentId,
  branch: string,
  installed: number,
  removed: number,
  overridesApplied: number
): string {
  return (
    `Applied ${hostAgentLabel(agent)} skill set for \`${branch}\`: +${installed}, -${removed}, ` +
    `${overridesApplied} override(s); mirrored to ${hostAgentMirrorDir(agent)}.`
  );
}

export function captureAgentSkillSet(target: string, agent: AgentId): AgentSkillSet | undefined {
  const branch = getCurrentBranch(target);
  if (!branch) {
    return undefined;
  }
  const repo = getGitRepository(target);
  return {
    agent,
    branch,
    skills: listEffectiveEnabledSkills(target),
    skillOverrides: { ...readSkillOverrides(target) },
    updatedAt: new Date().toISOString(),
    workspacePath: path.normalize(target),
    remoteUrl: repo ? originRemoteUrl(repo) : undefined,
  };
}

export function saveAgentSkillSet(
  target: string,
  agent: AgentId = detectHostAgentId()
): AgentSkillSet | undefined {
  if (!agentProfilesEnabled()) {
    return undefined;
  }
  const key = repoKeyFor(target);
  const profile = captureAgentSkillSet(target, agent);
  if (!key || !profile) {
    return undefined;
  }

  const store = readStore();
  const repo = store.repos[key] ?? {
    workspacePath: profile.workspacePath,
    remoteUrl: profile.remoteUrl,
    branches: {},
  };
  repo.remoteUrl = profile.remoteUrl ?? repo.remoteUrl;
  repo.workspacePath = profile.workspacePath;
  const branchEntry = repo.branches[profile.branch] ?? { sets: {} };
  branchEntry.sets[agent] = profile;
  branchEntry.lastActiveAgent = agent;
  repo.branches[profile.branch] = branchEntry;
  store.repos[key] = repo;
  writeStore(store);
  return profile;
}

export function loadAgentSkillSet(
  target: string,
  branch: string,
  agent: AgentId
): AgentSkillSet | undefined {
  const key = repoKeyFor(target);
  if (!key) {
    return undefined;
  }
  return readStore().repos[key]?.branches[branch]?.sets[agent];
}

export function listAgentSkillSetsForBranch(target: string, branch: string): AgentSkillSet[] {
  const key = repoKeyFor(target);
  if (!key) {
    return [];
  }
  const sets = readStore().repos[key]?.branches[branch]?.sets ?? {};
  return (Object.values(sets).filter(Boolean) as AgentSkillSet[]).sort((a, b) =>
    a.agent.localeCompare(b.agent)
  );
}

function agentSetToBranchProfile(set: AgentSkillSet): BranchSkillProfile {
  return {
    branch: set.branch,
    skills: set.skills,
    skillOverrides: set.skillOverrides,
    updatedAt: set.updatedAt,
    workspacePath: set.workspacePath,
    remoteUrl: set.remoteUrl,
  };
}

export function applyAgentSkillSet(
  libraryDir: string,
  target: string,
  set: AgentSkillSet,
  opts?: { removeExtra?: boolean }
): ApplyProfileResult {
  const result = applyBranchProfile(libraryDir, target, agentSetToBranchProfile(set), opts);
  const key = repoKeyFor(target);
  if (key) {
    const store = readStore();
    const repo = store.repos[key];
    const branchEntry = repo?.branches[set.branch];
    if (repo && branchEntry) {
      branchEntry.lastActiveAgent = set.agent;
      writeStore(store);
    }
  }
  return result;
}

export function maybeApplyHostAgentSkillSet(
  libraryDir: string,
  target: string,
  log: (line: string) => void
): boolean {
  if (!agentProfilesEnabled() || !autoApplyOnActivate()) {
    return false;
  }
  const branch = getCurrentBranch(target);
  if (!branch) {
    return false;
  }
  const agent = detectHostAgentId();
  const saved = loadAgentSkillSet(target, branch, agent);
  if (!saved) {
    return false;
  }

  const current = new Set(listEffectiveEnabledSkills(target));
  const savedSet = new Set(saved.skills);
  const sameSkills =
    current.size === savedSet.size && [...current].every((s) => savedSet.has(s));
  if (sameSkills) {
    return false;
  }

  const result = applyAgentSkillSet(libraryDir, target, saved);
  log(
    formatHostSkillSetAppliedMessage(
      agent,
      branch,
      result.installed.length,
      result.removed.length,
      result.overridesApplied
    )
  );
  return true;
}

export function formatAgentSkillSetsReport(target: string): string {
  const branch = getCurrentBranch(target);
  const host = detectHostAgentId();
  const lines = [
    `# IDE / agent skill sets (${hostAgentLabel(host)} host)`,
    "",
    `Store: ${AGENT_SKILL_PROFILES_PATH}`,
    branch ? `Branch: \`${branch}\`` : "Branch: (not on git branch)",
    "",
  ];
  if (!branch) {
    return lines.join("\n");
  }

  const sets = listAgentSkillSetsForBranch(target, branch);
  if (sets.length === 0) {
    lines.push("No saved skill sets for this branch yet.");
    lines.push("");
    lines.push("Use **Save Skill Set for Current IDE** after tuning skills in Cursor, Kiro, or VS Code.");
    return lines.join("\n");
  }

  lines.push("| Agent | Skills | Overrides | Updated |");
  lines.push("|-------|--------|-----------|---------|");
  for (const set of sets) {
    const marker = set.agent === host ? " *(host)*" : "";
    lines.push(
      `| ${hostAgentLabel(set.agent)}${marker} | ${set.skills.length} | ${Object.keys(set.skillOverrides).length} | ${set.updatedAt.slice(0, 16).replace("T", " ")} |`
    );
  }
  lines.push("");
  lines.push("Saved sets are per git branch and per agent (Cursor, Kiro, Copilot, Claude Code).");
  lines.push("Switch IDE skill set to apply a different agent's saved layout to `.claude/skills/`.");
  return lines.join("\n");
}

/** Also persist host agent set when branch profile is saved (optional setting). */
export function maybeSaveHostAgentSetWithBranchProfile(target: string): AgentSkillSet | undefined {
  if (!saveOnBranchProfileSave() || !agentProfilesEnabled()) {
    return undefined;
  }
  return saveAgentSkillSet(target, detectHostAgentId());
}

export async function promptSwitchAgentSkillSet(
  libraryDir: string,
  target: string,
  log: (line: string) => void
): Promise<ApplyProfileResult | undefined> {
  const branch = getCurrentBranch(target);
  if (!branch) {
    vscode.window.showWarningMessage("Claude Skills: git branch required to switch IDE skill sets.");
    return undefined;
  }

  const host = detectHostAgentId();
  const allAgents: AgentId[] = ["cursor", "kiro", "copilot", "claude"];
  const items: vscode.QuickPickItem[] = allAgents.map((agent) => {
    const saved = loadAgentSkillSet(target, branch, agent);
    const suffix = saved ? `${saved.skills.length} skills` : "not saved";
    const hostTag = agent === host ? " — current IDE" : "";
    return {
      label: hostAgentLabel(agent),
      description: suffix + hostTag,
      detail: saved?.updatedAt ? `Updated ${saved.updatedAt.slice(0, 16).replace("T", " ")}` : undefined,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Switch skill set (${branch})`,
    placeHolder: "Apply a saved skill layout for another IDE / agent",
  });
  if (!picked) {
    return undefined;
  }

  const agent = allAgents.find((a) => hostAgentLabel(a) === picked.label);
  if (!agent) {
    return undefined;
  }

  let saved = loadAgentSkillSet(target, branch, agent);
  if (!saved) {
    const create = await vscode.window.showWarningMessage(
      `No saved skill set for ${hostAgentLabel(agent)} on \`${branch}\`. Save current layout first?`,
      "Save current as this IDE",
      "Cancel"
    );
    if (create !== "Save current as this IDE") {
      return undefined;
    }
    saved = saveAgentSkillSet(target, agent);
    if (!saved) {
      return undefined;
    }
  }

  if (agent === host) {
    const saveFirst = await vscode.window.showInformationMessage(
      `Save current ${hostAgentLabel(host)} layout before re-applying?`,
      "Save & apply",
      "Apply only",
      "Cancel"
    );
    if (saveFirst === "Cancel") {
      return undefined;
    }
    if (saveFirst === "Save & apply") {
      saveAgentSkillSet(target, host);
      saved = loadAgentSkillSet(target, branch, agent) ?? saved;
    }
  }

  const result = applyAgentSkillSet(libraryDir, target, saved);
  log(
    `\n=== Switch IDE skill set -> ${hostAgentLabel(agent)} (${branch}) ===\n+${result.installed.length} installed, -${result.removed.length} removed, ${result.overridesApplied} override(s).`
  );
  vscode.window.showInformationMessage(
    `Claude Skills: applied ${hostAgentLabel(agent)} skill set (${saved.skills.length} skills).`
  );
  return result;
}
