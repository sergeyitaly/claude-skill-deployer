import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildCopilotInstructionsFile } from "./copilotTransform";
import { copySkill, discoverBundledSkills, detectRelevantSkills, InstallResult, loadManifest, Manifest } from "./skillOps";
import { computeCreditUsageFromRoots } from "./usageCost";

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
  return JSON.parse(fs.readFileSync(file, "utf-8")) as AgentsManifest;
}

export function enabledAgents(libraryDir: string): AgentId[] {
  const manifest = loadAgentsManifest(libraryDir);
  const configured = vscode.workspace.getConfiguration("claudeSkills.agents").get<AgentId[]>("enabled", [
    "claude",
    "cursor",
    "kiro",
  ]);
  return configured.filter((id) => id in manifest.agents);
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
  if (fs.existsSync(destFile) && !force) {
    return "skipped-exists";
  }
  if (dryRun) {
    return "would-install";
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, buildCopilotInstructionsFile(skillName, detectGlobs, sourceSkillMd), "utf-8");
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

/** Mirror learning artifacts (reports, budget, branch profiles) to other agents' learning dirs. */
export function mirrorLearningArtifacts(target: string, libraryDir: string): string[] {
  const agentsManifest = loadAgentsManifest(libraryDir);
  const ids = enabledAgents(libraryDir).filter((id) => id !== "claude");
  const sourceDir = path.join(target, ".claude", "learning");
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith(".md") || f.endsWith(".json"));
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

export function computeEnabledAgentsCreditUsage(libraryDir: string, daysBack = 14) {
  const roots = enabledTranscriptRoots(libraryDir);
  if (roots.length === 0) {
    return computeCreditUsageFromRoots([], daysBack);
  }
  return computeCreditUsageFromRoots(roots, daysBack);
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
