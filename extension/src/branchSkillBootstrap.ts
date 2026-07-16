import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { saveBranchProfile } from "./branchProfiles";
import { mergeProfileInitSkills, profileInitRequiredSkills } from "./profileInit";
import {
  detectRelevantSkills,
  installSkillsToWorkspace,
  isSkillCommittedOnBranch,
  loadManifest,
  markSkillAsPersonalLocal,
  Manifest,
  removeSkill,
} from "./skillOps";
import { applyTaskSkillFocus, taskSkillFocusEnabled } from "./taskSkillFocus";
import { capActiveSkills, readTaskFocusLimits } from "./taskFocusConfig";
import { computeTaskSkillProposals, writeTaskSkillProposals, TaskSkillProposalsFile } from "./taskSkillProposals";
import { propagateCostDisciplineToAgents } from "./agentMirrorSync";
import { bootstrapWorkspaceForHostAgent } from "./hostAgentBootstrap";

export type BranchSkillFlavor = "infra" | "app" | "general";

const INFRA_BRANCH_RE =
  /(^|\/)(infra|devops|terraform|iac|pipeline|deploy|ops|ci|release|platform)(\/|$|[-_])/i;
const APP_BRANCH_RE =
  /(^|\/)(app|feature|frontend|fe|ui|web|api|backend|mobile|client)(\/|$|[-_])/i;

const FLAVOR_HINTS: Record<Exclude<BranchSkillFlavor, "general">, string[]> = {
  infra: [
    "terraform-plan-review",
    "terraform-module-ops",
    "ci-pipeline-debug",
    "ci-preflight",
    "deployment-practical",
    "cross-platform-scripting",
    "gitlab-pipeline-ops",
    "azure-rbac-diagnostics",
  ],
  app: [
    "frontend-design",
    "webapp-testing",
    "web-artifacts-builder",
    "mcp-builder",
    "doc-coauthoring",
  ],
};

export function branchSkillBootstrapEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.branchBootstrap").get<boolean>("enabled", true);
}

export function relevantInstallOnlyEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.branchBootstrap").get<boolean>("relevantInstallOnly", true);
}

export function inferBranchSkillFlavor(branch: string): BranchSkillFlavor {
  const normalized = branch.trim();
  if (INFRA_BRANCH_RE.test(normalized)) {
    return "infra";
  }
  if (APP_BRANCH_RE.test(normalized)) {
    return "app";
  }
  return "general";
}

/** Plan a capped skill set for a branch with no saved profile yet. */
export function planBranchBootstrapSkills(
  target: string,
  manifest: Manifest,
  branch: string
): { flavor: BranchSkillFlavor; skills: string[]; capped: boolean } {
  const flavor = inferBranchSkillFlavor(branch);
  const limits = readTaskFocusLimits();
  const detected = detectRelevantSkills(target, manifest);
  const relevantNames = Object.keys(detected);
  const manifestNames = new Set(Object.keys(manifest.skills));

  const candidates: string[] = [];
  const confidence = new Map<string, number>();

  for (const name of relevantNames) {
    candidates.push(name);
    confidence.set(name, 70);
  }

  if (flavor !== "general") {
    for (const hint of FLAVOR_HINTS[flavor]) {
      if (!manifestNames.has(hint)) {
        continue;
      }
      if (!candidates.includes(hint)) {
        candidates.push(hint);
      }
      confidence.set(hint, Math.max(confidence.get(hint) ?? 0, 75));
    }
  }

  const required = profileInitRequiredSkills();
  const { active, capped } = capActiveSkills(candidates, {
    maxActiveSkills: limits.maxActiveSkills,
    requiredSkills: required,
    confidenceBySkill: confidence,
  });

  return {
    flavor,
    skills: mergeProfileInitSkills(active),
    capped,
  };
}

export interface BranchBootstrapResult {
  bootstrapped: boolean;
  flavor?: BranchSkillFlavor;
  skills: string[];
  installed: string[];
  capped?: boolean;
}

/** Seed a new branch with a relevant, capped skill set instead of snapshotting main's chaos. */
export function bootstrapBranchSkillSet(
  libraryDir: string,
  target: string,
  branch: string
): BranchBootstrapResult {
  if (!branchSkillBootstrapEnabled()) {
    return { bootstrapped: false, skills: [], installed: [] };
  }

  bootstrapWorkspaceForHostAgent(libraryDir, target);

  const manifest = loadManifest(libraryDir);
  const plan = planBranchBootstrapSkills(target, manifest, branch);
  if (plan.skills.length === 0) {
    return { bootstrapped: false, skills: [], installed: [] };
  }

  const installResults = installSkillsToWorkspace(libraryDir, target, plan.skills, {
    force: false,
    dryRun: false,
  });
  const installed = installResults
    .filter((r) => r.status === "installed" || r.status === "skipped-exists")
    .map((r) => r.skill);

  for (const skill of installed) {
    markSkillAsPersonalLocal(target, skill);
  }

  const proposals = computeTaskSkillProposals(target, manifest, `branch:${branch}`, `Branch ${branch}`);
  const proposalNames = new Set(proposals.map((p) => p.name));
  const mergedProposals = [
    ...proposals,
    ...plan.skills
      .filter((name) => !proposalNames.has(name))
      .map((name) => ({
        name,
        reason: `Branch bootstrap (${plan.flavor})`,
        confidence: 80,
        installed: true,
      })),
  ]
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, readTaskFocusLimits().maxActiveSkills);

  const proposalFile: TaskSkillProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    taskSummary: `Branch ${branch} (${plan.flavor})`,
    proposals: mergedProposals,
  };
  writeTaskSkillProposals(target, proposalFile);

  // claudeSkills.taskFocus.enabled is the master switch for auto-disabling installed
  // skills via skillOverrides; unlike every other applyTaskSkillFocus call site, this
  // one used to fire unconditionally and would force-disable any installed skill the
  // capped branch plan didn't include (e.g. mcp-builder on a "general"-flavored branch).
  if (taskSkillFocusEnabled()) {
    applyTaskSkillFocus(target, plan.skills, "task-skill-proposals", proposalFile.generatedAt);
  }

  saveBranchProfile(target, libraryDir);
  propagateCostDisciplineToAgents(libraryDir, target);

  return {
    bootstrapped: true,
    flavor: plan.flavor,
    skills: plan.skills,
    installed,
    capped: plan.capped,
  };
}

/** Remove personal-local library skills that are not relevant to this workspace. */
export function pruneIrrelevantPersonalSkills(
  libraryDir: string,
  target: string,
  manifest: Manifest
): string[] {
  if (!relevantInstallOnlyEnabled()) {
    return [];
  }
  const detected = new Set(Object.keys(detectRelevantSkills(target, manifest)));
  const required = new Set(profileInitRequiredSkills());
  const skillsDir = path.join(target, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const removed: string[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const name = entry.name;
    if (!(name in manifest.skills)) {
      continue;
    }
    if (detected.has(name) || required.has(name)) {
      continue;
    }
    if (isSkillCommittedOnBranch(target, name)) {
      continue;
    }
    if (removeSkill(skillsDir, name)) {
      removed.push(name);
    }
  }
  return removed.sort((a, b) => a.localeCompare(b));
}
