import * as fs from "node:fs";
import * as path from "node:path";
import { getCurrentBranch } from "./branchProfiles";
import { sessionCostSince } from "./costOptimizer";
import { formatCompactUsd } from "./skillCost";

export interface CommitCostRecord {
  commit: string;
  timestamp: string;
  cost: number;
  branch: string | null;
  files_changed: string[];
  tokens?: number;
}

const COMMIT_COSTS_RELATIVE = path.join(".claude", "learning", "commit-costs.jsonl");

function commitCostsPath(target: string): string {
  return path.join(target, COMMIT_COSTS_RELATIVE);
}

export function appendCommitCost(target: string, record: CommitCostRecord): void {
  const file = commitCostsPath(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8");
}

export function readCommitCosts(target: string): CommitCostRecord[] {
  const file = commitCostsPath(target);
  if (!fs.existsSync(file)) {
    return [];
  }
  const rows: CommitCostRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      rows.push(JSON.parse(line) as CommitCostRecord);
    } catch {
      // skip
    }
  }
  return rows;
}

export async function recordCommitCost(
  target: string,
  commitHash: string,
  filesChanged: string[],
  sinceIso?: string
): Promise<CommitCostRecord> {
  const since = sinceIso ?? new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const cost = sessionCostSince(target, since);
  const record: CommitCostRecord = {
    commit: commitHash,
    timestamp: new Date().toISOString(),
    cost,
    branch: getCurrentBranch(target) ?? null,
    files_changed: filesChanged,
  };
  appendCommitCost(target, record);
  return record;
}

export function installGitPostCommitHook(target: string, extensionPath: string): "installed" | "already-configured" {
  const gitDir = path.join(target, ".git");
  const hooksDir = path.join(gitDir, "hooks");
  const hookPath = path.join(hooksDir, "post-commit");
  const scriptSource = path.join(extensionPath, "resources", "hooks", "commit-cost-record.js");
  const scriptDest = path.join(target, ".claude", "hooks", "commit-cost-record.js");

  if (!fs.existsSync(gitDir)) {
    throw new Error("Not a git repository");
  }

  fs.mkdirSync(path.dirname(scriptDest), { recursive: true });
  fs.copyFileSync(scriptSource, scriptDest);

  const hookBody = `#!/bin/sh
node "${scriptDest.replace(/\\/g, "/")}" "$@"
`;

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf-8");
    if (existing.includes("commit-cost-record.js")) {
      fs.copyFileSync(scriptSource, scriptDest);
      return "already-configured";
    }
    fs.writeFileSync(hookPath, existing.trimEnd() + "\n\n" + hookBody, "utf-8");
  } else {
    fs.writeFileSync(hookPath, hookBody, "utf-8");
  }

  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // Windows may ignore chmod
  }

  return "installed";
}

export function formatCommitCostMessage(record: CommitCostRecord): string {
  if (record.cost <= 0) {
    return "Claude Skills: no attributed session cost for this commit window.";
  }
  return `Claude Skills: this commit window cost ~${formatCompactUsd(record.cost)} in estimated credits.`;
}
