#!/usr/bin/env node
// Daily budget + economy mode on every prompt submit.
// Claude: UserPromptSubmit (systemMessage)
// Cursor: beforeSubmitPrompt (additional_context)
// Kiro: promptSubmit (additional_context)
// Copilot: UserPromptSubmit (hookSpecificOutput)

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { computeTodayUsageAcrossProjectsCached, formatTokenCount, formatUsd } = require("./usageParse");
const { readStdin, parsePlatform, resolveCwd, writePromptOutput } = require("./hookPlatform");

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
  mediumTierSkills: [],
  lowTierSkills: [],
};

const FALLBACK_CONFIG = {
  80: {
    action: "warn",
    message: "Budget at 80% - consider /compact",
  },
  90: {
    action: "switch_agent",
    toAgent: "cursor",
    excludeSkills: ["high"],
    message: "Budget critical - switching non-critical skills to Cursor (disable high-tier locally)",
  },
  95: {
    action: "restrict",
    allowedTiers: ["low"],
    message: "Budget exhausted - only low-cost skills available",
  },
  100: {
    action: "readonly",
    message: "Daily budget exceeded - run /clear or wait for reset",
  },
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

function disableSkills(cwd, skills, reason, stateKey) {
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  const settings = readJsonSafe(settingsPath, {});
  const overrides = { ...(settings.skillOverrides || {}) };
  const meta = settings[BUDGET_META_KEY] || {};
  const previouslyBudgetDisabled = new Set(meta[stateKey] || []);
  const disabledNow = [];

  for (const skill of skills) {
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
  meta[stateKey] = [...new Set([...(meta[stateKey] || []), ...disabledNow])].sort((a, b) => a.localeCompare(b));
  meta.disabledReason = reason;
  settings[BUDGET_META_KEY] = meta;
  writeJsonSafe(settingsPath, settings);
  return disabledNow;
}

function disableHighTierSkills(cwd, highTierSkills, reason) {
  return disableSkills(cwd, highTierSkills, reason, "disabledByBudget");
}

function skillsOutsideTiers(config, allowedTiers) {
  const allowed = new Set(allowedTiers);
  const all = [
    ...(config.highTierSkills || []).map((s) => ({ s, t: "high" })),
    ...(config.mediumTierSkills || []).map((s) => ({ s, t: "medium" })),
    ...(config.lowTierSkills || []).map((s) => ({ s, t: "low" })),
  ];
  return all.filter(({ t }) => !allowed.has(t)).map(({ s }) => s);
}

function applyFallbackAction(cwd, config, pct, state, today, messages) {
  const thresholds = Object.keys(FALLBACK_CONFIG)
    .map((k) => Number.parseInt(k, 10))
    .sort((a, b) => b - a);
  const hit = thresholds.find((t) => pct >= t);
  if (!hit) {
    return;
  }
  const fb = FALLBACK_CONFIG[hit];
  const noticeKey = `fallback${hit}`;
  const notices = todayNotifications(state, today);
  if (notices[noticeKey]) {
    return;
  }
  notices[noticeKey] = true;

  if (fb.action === "warn") {
    messages.push(`[Claude Skills] ${fb.message}`);
    return;
  }

  if (fb.action === "switch_agent") {
    const toDisable = (config.highTierSkills || []).filter((s) =>
      (fb.excludeSkills || []).includes("high") ? config.highTierSkills.includes(s) : true
    );
    const disabled = disableHighTierSkills(cwd, toDisable, `budget-${hit}pct`);
    messages.push(`[Claude Skills] ${fb.message}`);
    if (disabled.length > 0) {
      messages.push(`[Claude Skills] Disabled ${disabled.length} high-tier skill(s): ${disabled.join(", ")}.`);
    }
    if (fb.toAgent) {
      messages.push(`[Claude Skills] Consider running medium/low-tier tasks in ${fb.toAgent} to preserve Claude budget.`);
    }
    return;
  }

  if (fb.action === "restrict") {
    const blocked = skillsOutsideTiers(config, fb.allowedTiers || ["low"]);
    const disabled = disableSkills(cwd, blocked, `budget-${hit}pct-restrict`, "disabledByBudgetRestrict");
    messages.push(`[Claude Skills] ${fb.message}`);
    if (disabled.length > 0) {
      messages.push(`[Claude Skills] Restricted ${disabled.length} skill(s) to low-tier only.`);
    }
    return;
  }

  if (fb.action === "readonly") {
    state.readonlyMode = true;
    state.readonlyModeDate = today;
    messages.push(`[Claude Skills] ${fb.message}`);
  }
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
  const platform = parsePlatform(process.argv);
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    input = {};
  }

  const cwd = resolveCwd(input, platform);
  if (!cwd) {
    return;
  }

  const config = { ...DEFAULT_CONFIG, ...readJsonSafe(BUDGET_CONFIG_PATH, {}) };
  const { totalTokens, totalCostUsd, date: today } = computeTodayUsageAcrossProjectsCached();
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

    applyFallbackAction(cwd, config, pct, state, today, messages);

    if (!notices.warn && pct >= warnAt && pct < 100) {
      notices.warn = true;
      messages.push(
        `[Claude Skills] Daily budget warning: ~${formatUsd(totalCostUsd)} of ${formatUsd(config.dailyBudgetUsd)} (${Math.round(pct)}%). Consider /compact or disabling unused skills.`
      );
    }

    if (pct >= 100) {
      notices.critical = true;
      messages.push(
        `[Claude Skills] Daily budget exceeded: ~${formatUsd(totalCostUsd)} of ${formatUsd(config.dailyBudgetUsd)} (${formatTokenCount(totalTokens)} tokens today). Raise the budget tier in Claude Skills Manager to continue without this warning.`
      );

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
    writePromptOutput(messages.join(" "), platform, "systemMessage");
  }
}

main();
