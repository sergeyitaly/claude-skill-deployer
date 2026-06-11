#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: enforces daily token budget and economy
// mode. Reads ~/.claude/learning/budget.json (synced by the VS Code extension).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { computeTodayUsageAcrossProjects, formatTokenCount, formatUsd } = require("./usageParse");

const LEARNING_DIR = path.join(os.homedir(), ".claude", "learning");
const BUDGET_CONFIG_PATH = path.join(LEARNING_DIR, "budget.json");
const BUDGET_STATE_PATH = path.join(LEARNING_DIR, "budget-state.json");
const BUDGET_META_KEY = "claudeSkillsBudget";

const DEFAULT_CONFIG = {
  mode: "normal",
  dailyBudgetUsd: 5,
  warnThresholdPercent: 80,
  economyWarnUsd: 0.1,
  unlimitedNotifyUsd: 10,
  autoDisableHighTierOnBudgetHit: true,
  highTierSkills: [],
};

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function disableHighTierSkills(cwd, highTierSkills, reason) {
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  const settings = readJsonSafe(settingsPath, {});
  const overrides = { ...(settings.skillOverrides || {}) };
  const meta = settings[BUDGET_META_KEY] || {};
  const previouslyBudgetDisabled = new Set(meta.disabledByBudget || []);
  const disabledNow = [];

  for (const skill of highTierSkills) {
    if (overrides[skill] === "off" && !previouslyBudgetDisabled.has(skill)) {
      continue;
    }
    if (overrides[skill] !== "off") {
      overrides[skill] = "off";
      disabledNow.push(skill);
    } else if (previouslyBudgetDisabled.has(skill)) {
      disabledNow.push(skill);
    }
  }

  if (disabledNow.length === 0) {
    return [];
  }

  settings.skillOverrides = overrides;
  settings[BUDGET_META_KEY] = {
    disabledByBudget: [...new Set([...(meta.disabledByBudget || []), ...disabledNow])].sort(),
    disabledReason: reason,
  };
  writeJsonSafe(settingsPath, settings);
  return disabledNow;
}

function todayNotifications(state, today) {
  if (!state.notifications) {
    state.notifications = {};
  }
  if (!state.notifications[today]) {
    state.notifications[today] = {};
  }
  return state.notifications[today];
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  const cwd = input.cwd;
  if (!cwd) {
    return;
  }

  const config = { ...DEFAULT_CONFIG, ...readJsonSafe(BUDGET_CONFIG_PATH, {}) };
  const { totalTokens, totalCostUsd, date: today } = computeTodayUsageAcrossProjects();
  const state = readJsonSafe(BUDGET_STATE_PATH, {});
  const notices = todayNotifications(state, today);
  const messages = [];

  if (config.mode === "economy") {
    if (config.highTierSkills.length > 0) {
      const disabled = disableHighTierSkills(cwd, config.highTierSkills, "economy");
      if (disabled.length > 0 && state.lastEconomyApplyDate !== today) {
        state.lastEconomyApplyDate = today;
        messages.push(
          `[Claude Skills] Economy mode: disabled ${disabled.length} high-tier skill(s) locally (${disabled.join(", ")}). Re-enable via Claude Skills Manager or switch to Normal mode.`
        );
      }
    }
    if (!notices.economyWarn && config.economyWarnUsd > 0 && totalCostUsd >= config.economyWarnUsd) {
      notices.economyWarn = true;
      messages.push(
        `[Claude Skills] Economy mode: today's spend is ~${formatUsd(totalCostUsd)} (${formatTokenCount(totalTokens)} tokens). Consider /compact to reduce context cost.`
      );
    }
  }

  if (config.mode === "unlimited") {
    if (!notices.unlimitedNotify && config.unlimitedNotifyUsd > 0 && totalCostUsd >= config.unlimitedNotifyUsd) {
      notices.unlimitedNotify = true;
      messages.push(
        `[Claude Skills] Unlimited mode notice: today's spend reached ~${formatUsd(totalCostUsd)} (${formatTokenCount(totalTokens)} tokens).`
      );
    }
  }

  if (config.dailyBudgetUsd > 0) {
    const pct = (totalCostUsd / config.dailyBudgetUsd) * 100;
    const warnAt = config.warnThresholdPercent ?? 80;

    if (!notices.warn && pct >= warnAt && pct < 100) {
      notices.warn = true;
      messages.push(
        `[Claude Skills] Daily budget warning: ~${formatUsd(totalCostUsd)} of ${formatUsd(config.dailyBudgetUsd)} (${Math.round(pct)}%). Consider /compact or disabling unused skills.`
      );
    }

    if (pct >= 100) {
      if (!notices.critical) {
        notices.critical = true;
        messages.push(
          `[Claude Skills] Daily budget exceeded: ~${formatUsd(totalCostUsd)} of ${formatUsd(config.dailyBudgetUsd)} (${formatTokenCount(totalTokens)} tokens today).`
        );
      }

      if (config.autoDisableHighTierOnBudgetHit && config.highTierSkills.length > 0) {
        const alreadyDone =
          state.lastAutoDisableDate === today &&
          JSON.stringify(state.lastAutoDisabledSkills || []) === JSON.stringify(config.highTierSkills);
        if (!alreadyDone) {
          const disabled = disableHighTierSkills(cwd, config.highTierSkills, "budget-exceeded");
          if (disabled.length > 0) {
            state.lastAutoDisableDate = today;
            state.lastAutoDisabledSkills = [...config.highTierSkills];
            messages.push(
              `[Claude Skills] Budget exceeded: auto-disabled ${disabled.length} high-tier skill(s) for this workspace (${disabled.join(", ")}). Restore via Claude Skills Manager when under budget.`
            );
          }
        }
      }
    }
  }

  writeJsonSafe(BUDGET_STATE_PATH, state);

  if (messages.length > 0) {
    process.stdout.write(JSON.stringify({ systemMessage: messages.join(" ") }));
  }
}

main();
