import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BudgetConfig } from "./budgetConfig";
import { localDateKey } from "./localDate";

export const TODAY_COST_PATH = path.join(os.homedir(), ".claude", "learning", "today-cost.json");

export function readTodayCostUsd(): number {
  if (!fs.existsSync(TODAY_COST_PATH)) {
    return 0;
  }
  try {
    const data = JSON.parse(fs.readFileSync(TODAY_COST_PATH, "utf-8")) as { date?: string; costUsd?: number };
    if (data.date === localDateKey()) {
      return data.costUsd ?? 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

export function writeTodayCostSnapshot(costUsd: number, tokens: number): void {
  const payload = {
    date: localDateKey(),
    costUsd,
    tokens,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(TODAY_COST_PATH), { recursive: true });
  fs.writeFileSync(TODAY_COST_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

export function remainingDailyBudgetUsd(config: BudgetConfig): number | null {
  if (config.dailyBudgetUsd <= 0) {
    return null;
  }
  const spent = readTodayCostUsd();
  return Math.max(0, config.dailyBudgetUsd - spent);
}

export function budgetProgressBar(percent: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
