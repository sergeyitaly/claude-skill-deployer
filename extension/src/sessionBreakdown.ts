import { readEnrichedRuns } from "./usageStats";
import { formatTokenCount } from "./usageStats";

export interface SessionSkillRow {
  skill: string;
  tokens: number;
  cost: number;
}

export function generateSessionBreakdown(target: string, sessionId: string): string {
  const runs = readEnrichedRuns(target).filter((r) => r.session_id === sessionId);
  if (runs.length === 0) {
    return `No runs found for session: ${sessionId}`;
  }

  const totalCost = runs.reduce((sum, r) => sum + r.cost, 0);
  const totalTokens = runs.reduce((sum, r) => sum + r.tokens, 0);

  const skillMap = new Map<string, SessionSkillRow>();
  for (const run of runs) {
    const existing = skillMap.get(run.skill) ?? { skill: run.skill, tokens: 0, cost: 0 };
    existing.tokens += run.tokens;
    existing.cost += run.cost;
    skillMap.set(run.skill, existing);
  }

  const rows = [...skillMap.values()].sort((a, b) => b.cost - a.cost);
  const maxCost = Math.max(...rows.map((v) => v.cost), 0.000001);

  let output = `\nSession: ${sessionId}\n`;
  output += `Total: $${totalCost.toFixed(2)} | ${formatTokenCount(totalTokens)} tokens\n\n`;
  output += `Skills active in this session:\n`;

  for (const data of rows) {
    const percentage = totalCost > 0 ? (data.cost / totalCost) * 100 : 0;
    const barLength = Math.max(0, Math.min(50, Math.floor((data.cost / maxCost) * 50)));
    const bar = "\u2588".repeat(barLength) + "\u2591".repeat(50 - barLength);
    output += `├── ${data.skill.padEnd(25)} $${data.cost.toFixed(2)} (${percentage.toFixed(0)}%)  ${bar} ${formatTokenCount(data.tokens)} tokens\n`;
  }

  return output;
}

/** Breakdown for the most recent session_id in runs.jsonl. */
export function generateLatestSessionBreakdown(target: string): string | null {
  const runs = readEnrichedRuns(target);
  if (runs.length === 0) {
    return null;
  }
  const sorted = [...runs].sort((a, b) => b.ts.localeCompare(a.ts));
  const sessionId = sorted[0].session_id;
  return generateSessionBreakdown(target, sessionId);
}
