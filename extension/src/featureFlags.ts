import * as vscode from "vscode";
import { getProjectProfileFeatureOverride } from "./activeProjectProfile";

export type FeatureKey =
  | "budgetControls"
  | "branchProfiles"
  | "multiAgent"
  | "attributionCollector"
  | "costIntelligence"
  | "autoOptimizer"
  | "predictiveAlerts"
  | "communityBenchmarks"
  | "teamCostSharing"
  | "skillArchival"
  | "emergencyCutoff"
  | "prCostEstimate"
  | "costAwareSearch"
  | "skillSetResolver"
  | "contextFocus"
  | "practicalFocus"
  | "sessionSkillAdaptation"
  | "autoApplyTaskProposals"
  | "deterministicTaskProposals"
  | "taskSkillFocus"
  | "taskDriftReproposal";

export const DEFAULTS: Record<FeatureKey, boolean> = {
  budgetControls: true,
  branchProfiles: true,
  multiAgent: true,
  attributionCollector: true,
  costIntelligence: true,
  autoOptimizer: false,
  predictiveAlerts: true,
  communityBenchmarks: false,
  teamCostSharing: true,
  skillArchival: true,
  emergencyCutoff: true,
  prCostEstimate: false,
  costAwareSearch: true,
  skillSetResolver: true,
  contextFocus: true,
  practicalFocus: true,
  sessionSkillAdaptation: true,
  autoApplyTaskProposals: true,
  deterministicTaskProposals: true,
  taskSkillFocus: true,
  taskDriftReproposal: true,
};

export const FEATURE_DESCRIPTIONS: Record<FeatureKey, string> = {
  budgetControls: "Daily budget, economy mode, and cost control hooks.",
  branchProfiles: "Per-git-branch skill profiles.",
  multiAgent: "Deploy skills to all enabled agents (solo-dev: host IDE only).",
  attributionCollector: "Background transcript attribution collector.",
  costIntelligence: "Cost dashboard, optimization suggestions, and reports.",
  autoOptimizer: "Enable the auto-optimizer timer (off by default; turn on only after attribution looks reliable).",
  predictiveAlerts: "Weekly trend warnings when spend is projected over budget.",
  communityBenchmarks: "Community cost benchmarks (opt-in telemetry).",
  teamCostSharing: "Attribute skill cost to git authors in shared .claude/skills/.",
  skillArchival: "Archive idle expensive skills to .claude/skills-archived/.",
  emergencyCutoff: "Hard daily spend cutoff that disables all workspace skills.",
  prCostEstimate: "GitHub PR cost estimate via gh CLI.",
  costAwareSearch: "Show ROI/cost in skills tree and enable cost-based sorting.",
  skillSetResolver:
    "Weekly scheduled install of relevant skills and removal of skills that no longer match this workspace.",
  contextFocus:
    "Context focus level toggle and grounding hook (local workspace vs general LLM knowledge) to reduce hallucination in long sessions.",
  practicalFocus:
    "Practical/deployment focus toggle and hook — concrete architecture and first-try deploy steps over theoretical advice.",
  sessionSkillAdaptation:
    "On each new AI agent session or window, install and locally enable proposed skills from the branch profile and task-skill-proposals.json.",
  autoApplyTaskProposals:
    "Auto-install and locally enable all skills listed in Proposed for current task (plus required platform skills) for this workspace only.",
  deterministicTaskProposals:
    "Extension refreshes task-skill-proposals.json from workspace heuristics and skips agent regeneration on new sessions when proposals are fresh (<24h).",
  taskSkillFocus:
    "After auto-apply, set skillOverrides off for installed skills outside the task proposal set so agents only see the focused skill list (saves tokens).",
  taskDriftReproposal:
    "When agents use skills outside the active task set or the session transcript grows large, refresh task-skill-proposals.json and re-apply task focus.",
};

export function isFeatureEnabled(key: FeatureKey): boolean {
  const tierOverride = getProjectProfileFeatureOverride(key);
  if (tierOverride !== undefined) {
    return tierOverride;
  }
  return vscode.workspace.getConfiguration("claudeSkills.features").get<boolean>(key, DEFAULTS[key]);
}

export function featureFlagLines(): string[] {
  return (Object.keys(DEFAULTS) as FeatureKey[]).map(
    (k) => `  ${k}: ${isFeatureEnabled(k) ? "on" : "off"}`
  );
}
