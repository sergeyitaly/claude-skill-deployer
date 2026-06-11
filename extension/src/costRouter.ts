import { AgentId } from "./agentOps";
import { readBudgetConfig } from "./budgetConfig";
import { AgentAttribution, cheapestAgentForSkill, SkillAttributionMap } from "./costAttribution";
import { remainingDailyBudgetUsd } from "./todayCostSnapshot";

export type TaskType = "quick-edit" | "analysis" | "planning" | "default";

const TASK_DEFAULT_AGENT: Record<TaskType, AgentId> = {
  "quick-edit": "copilot",
  analysis: "cursor",
  planning: "claude",
  default: "claude",
};

/** Suggest which agent to use for a skill given attribution data and budget. */
export function getOptimalAgent(
  skill: string,
  attribution: SkillAttributionMap,
  opts?: { taskType?: TaskType; remainingBudgetUsd?: number | null }
): AgentId {
  const taskType = opts?.taskType ?? "default";
  const remaining = opts?.remainingBudgetUsd ?? remainingDailyBudgetUsd(readBudgetConfig());

  if (remaining !== null) {
    if (remaining < 0.5) {
      return "copilot";
    }
    if (remaining < 1.0 && taskType !== "planning") {
      return "cursor";
    }
  }

  const cheapest = cheapestAgentForSkill(skill, attribution);
  if (cheapest && taskType === "default") {
    return cheapest;
  }

  return TASK_DEFAULT_AGENT[taskType];
}

export function formatRoutingSuggestion(
  skill: string,
  attribution: SkillAttributionMap,
  agent: AgentId
): string {
  const entry = attribution[skill];
  if (!entry) {
    return `No usage data for ${skill} — defaulting to ${agent} for this task type.`;
  }

  const parts = (Object.entries(entry) as [AgentId, AgentAttribution][])
    .filter(([, s]) => s.sessions > 0)
    .map(([id, s]) => `${id}: ~$${(s.cost / s.sessions).toFixed(2)}/run`)
    .join(", ");

  return `Suggested agent for ${skill}: **${agent}** (${parts || "no runs yet"}).`;
}
