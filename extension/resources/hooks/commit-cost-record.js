#!/usr/bin/env node
// Git post-commit hook: record estimated session cost to .claude/learning/commit-costs.jsonl

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BLENDED_USD_PER_M_TOKEN = 9;

function readJsonlCost(target, sinceMs) {
  const runsFile = path.join(target, ".claude", "learning", "runs.jsonl");
  if (!fs.existsSync(runsFile)) {
    return 0;
  }
  let total = 0;
  for (const line of fs.readFileSync(runsFile, "utf-8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const row = JSON.parse(line);
      const ts = new Date(row.ts || row.timestamp).getTime();
      if (ts >= sinceMs) {
        total += row.cost ?? (row.tokens || 0) / 1_000_000 * BLENDED_USD_PER_M_TOKEN;
      }
    } catch {
      // skip
    }
  }
  return total;
}

function git(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function main() {
  const target = process.cwd();
  const commit = git("git rev-parse HEAD", target);
  if (!commit) {
    return;
  }

  const branch = git("git rev-parse --abbrev-ref HEAD", target);
  const files = git("git diff-tree --no-commit-id --name-only -r HEAD", target)
    .split("\n")
    .filter(Boolean);

  const sinceMs = Date.now() - 4 * 60 * 60 * 1000;
  const cost = readJsonlCost(target, sinceMs);

  const record = {
    commit,
    timestamp: new Date().toISOString(),
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    branch: branch || null,
    files_changed: files,
  };

  const outFile = path.join(target, ".claude", "learning", "commit-costs.jsonl");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, JSON.stringify(record) + "\n", "utf-8");

  if (cost > 0) {
    const usd = cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
    console.log(`[Claude Skills] This commit window cost ~${usd} in estimated credits.`);
  }
}

main();
