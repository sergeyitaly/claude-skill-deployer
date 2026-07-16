import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BudgetConfig } from "./budgetConfig";
import { localDateKey } from "./localDate";

// Legacy machine-wide location — used only as a fallback for callers with no workspace
// target (e.g. a routing suggestion made outside any specific project). Per-project reads
// and writes go to <target>/.claude/learning/today-cost.json instead, since a single shared
// snapshot let whichever project's status bar refreshed last silently overwrite the number
// every other open project's budget-gating check read.
export const TODAY_COST_PATH = path.join(os.homedir(), ".claude", "learning", "today-cost.json");

function todayCostPath(target?: string): string {
  return target ? path.join(target, ".claude", "learning", "today-cost.json") : TODAY_COST_PATH;
}

export function readTodayCostUsd(target?: string): number {
  const file = todayCostPath(target);
  if (!fs.existsSync(file)) {
    return 0;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { date?: string; costUsd?: number };
    if (data.date === localDateKey()) {
      return data.costUsd ?? 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

export function writeTodayCostSnapshot(target: string | undefined, costUsd: number, tokens: number): void {
  const file = todayCostPath(target);
  const payload = {
    date: localDateKey(),
    costUsd,
    tokens,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

export function remainingDailyBudgetUsd(config: BudgetConfig, target?: string): number | null {
  if (config.dailyBudgetUsd <= 0) {
    return null;
  }
  const spent = readTodayCostUsd(target);
  return Math.max(0, config.dailyBudgetUsd - spent);
}

export function budgetProgressBar(percent: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
