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
  agent: AgentId,
  opts?: { remainingBudgetUsd?: number | null; taskType?: TaskType }
): string {
  const entry = attribution[skill];
  const remaining = opts?.remainingBudgetUsd ?? remainingDailyBudgetUsd(readBudgetConfig());
  const cheapest = cheapestAgentForSkill(skill, attribution);

  if (!entry) {
    return `No usage data for ${skill} — defaulting to ${agent} for this task type.`;
  }

  const parts = (Object.entries(entry) as [AgentId, AgentAttribution][])
    .filter(([, s]) => s.sessions > 0)
    .map(([id, s]) => `${id}: ~$${(s.cost / s.sessions).toFixed(2)}/run`)
    .join(", ");

  let line = `Suggested agent for ${skill}: **${agent}** (${parts || "no runs yet"}).`;

  if (remaining !== null && cheapest && agent !== cheapest) {
    if (remaining < 0.5 && agent === "copilot") {
      line += ` Daily budget nearly exhausted (~$${remaining.toFixed(2)} left) — routing to flat-rate Copilot; measured cheapest is **${cheapest}**.`;
    } else if (remaining < 1.0 && agent === "cursor" && (opts?.taskType ?? "default") !== "planning") {
      line += ` Low daily budget (~$${remaining.toFixed(2)} left) — preferring **cursor**; measured cheapest for this skill is **${cheapest}**.`;
    }
  }

  return line;
}
