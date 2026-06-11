import { execSync } from "node:child_process";
import * as vscode from "vscode";
import { isFeatureEnabled } from "./featureFlags";
import { buildCostAttribution, SkillAttributionMap } from "./costAttribution";
import { detectRelevantSkills, loadManifest, patternMatchesAny } from "./skillOps";
import { estimateSessionCostUsd, tierForSkill } from "./skillCost";

export interface PRSkillEstimate {
  name: string;
  avgCost: number;
}

function ghAvailable(): boolean {
  try {
    execSync("gh --version", { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function prChangedFiles(repoRoot: string, prNumber: number): string[] {
  const out = execSync(`gh pr view ${prNumber} --json files --jq ".files[].path"`, {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function avgCostForSkill(skill: string, attribution: SkillAttributionMap, libraryDir: string): number {
  const agents = attribution[skill];
  if (agents) {
    let sessions = 0;
    let cost = 0;
    for (const a of Object.values(agents)) {
      sessions += a?.sessions ?? 0;
      cost += a?.cost ?? 0;
    }
    if (sessions > 0) {
      return cost / sessions;
    }
  }
  const manifest = loadManifest(libraryDir);
  return estimateSessionCostUsd(tierForSkill(manifest.skills[skill]?.cost_estimate));
}

export function estimatePRReviewCost(
  target: string,
  libraryDir: string,
  prNumber: number,
  changedFiles?: string[]
): { estimatedCost: number; skills: PRSkillEstimate[] } {
  const manifest = loadManifest(libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const attribution = { ...built.skills, ...built.transcriptSkills };

  let files = changedFiles;
  if (!files && ghAvailable()) {
    try {
      files = prChangedFiles(target, prNumber);
    } catch {
      files = [];
    }
  }
  files = files ?? [];

  const detected = files.length > 0 ? detectFromFileList(files, manifest) : detectRelevantSkills(target, manifest);
  const skills: PRSkillEstimate[] = Object.keys(detected).map((name) => ({
    name,
    avgCost: avgCostForSkill(name, attribution, libraryDir),
  }));
  const estimatedCost = skills.reduce((s, r) => s + r.avgCost, 0);
  return { estimatedCost, skills };
}

function detectFromFileList(files: string[], manifest: import("./skillOps").Manifest): Record<string, string[]> {
  const paths = files.map((f) => f.replace(/\\/g, "/"));
  const out: Record<string, string[]> = {};
  for (const [name, rule] of Object.entries(manifest.skills)) {
    const matched = rule.detect_globs.filter((g) => patternMatchesAny(g, paths));
    if (matched.length > 0) {
      out[name] = matched;
    }
  }
  return out;
}

export function formatPRComment(estimate: { estimatedCost: number; skills: PRSkillEstimate[] }): string {
  const lines = [
    "**Claude Skills Cost Estimate**",
    "",
    `Reviewing this PR will use ~$${estimate.estimatedCost.toFixed(2)} in estimated credits.`,
    "",
    "Skills that will likely activate:",
    ...estimate.skills.map((s) => `- ${s.name}: ~$${s.avgCost.toFixed(2)}`),
    "",
    "Tip: Run locally first with `py generate_skills.py generate --dry-run`",
  ];
  return lines.join("\n");
}

export async function postPRComment(target: string, prNumber: number, body: string): Promise<boolean> {
  if (!ghAvailable()) {
    return false;
  }
  try {
    execSync(`gh pr comment ${prNumber} --body ${JSON.stringify(body)}`, { cwd: target, encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

export async function estimateAndCommentPR(
  target: string,
  libraryDir: string,
  prNumber: number
): Promise<void> {
  if (!isFeatureEnabled("prCostEstimate")) {
    vscode.window.showWarningMessage("Claude Skills: PR cost estimate feature is disabled.");
    return;
  }
  const estimate = estimatePRReviewCost(target, libraryDir, prNumber);
  const body = formatPRComment(estimate);
  const preview = await vscode.window.showInformationMessage(
    `PR #${prNumber} estimated cost: $${estimate.estimatedCost.toFixed(2)}. Post comment?`,
    "Post",
    "Copy",
    "Cancel"
  );
  if (preview === "Copy") {
    await vscode.env.clipboard.writeText(body);
    return;
  }
  if (preview === "Post") {
    const ok = await postPRComment(target, prNumber, body);
    vscode.window.showInformationMessage(ok ? "PR comment posted." : "Could not post PR comment (gh CLI).");
  }
}
