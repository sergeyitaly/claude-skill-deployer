import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export type ModelTier = "fast" | "balanced" | "reasoning" | "planning";
export type ModelScenario =
  | "quick-edit" | "implementation" | "debugging" | "architecture" | "review"
  | "infrastructure" | "audit" | "cost-analysis" | "prompt-coaching" | "file-optimization";

export interface ModelRoutingDecision {
  ts: string;
  agent: string;
  scenario: ModelScenario;
  tier: ModelTier;
  confidence: number;
  promptLength: number;
}

const LOG_REL = path.join(".claude", "learning", "model-routing.jsonl");

export function modelRoutingEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.modelRouting").get<boolean>("enabled", true);
}

function classifyScenario(prompt: string): { scenario: ModelScenario; confidence: number } {
  const text = prompt.toLowerCase();
  if (prompt.length < 180 && /\b(rename|format|style|typo|change|update|remove|add one|small)\b/.test(text)) {
    return { scenario: "quick-edit", confidence: 0.84 };
  }
  const hasArchitecture = /\b(architect|architecture|design|migrate|migration|trade-?off|strategy|plan)\b/.test(text);
  const hasDebugging = /\b(debug|fix|error|exception|failure|crash|broken|failing|traceback|timeout)\b/.test(text);
  if (hasArchitecture && hasDebugging) return { scenario: "architecture", confidence: 0.96 };
  if (/\b(audit|compliance|governance|telemetry|attribution|client asks|export)\b/.test(text)) {
    return { scenario: "audit", confidence: 0.9 };
  }
  if (/\b(cost|spend|budget|roi|billing|tokens|pricing|performance index|hace)\b/.test(text)) {
    return { scenario: "cost-analysis", confidence: 0.88 };
  }
  if (/\b(prompt|coaching|vague|clarity|success criteria|multi-goal|rewrite)\b/.test(text)) {
    return { scenario: "prompt-coaching", confidence: 0.86 };
  }
  if (/\b(read|write|edit|file i\/o|filesystem|mcp|re-?read|directory scan|redundant)\b/.test(text)) {
    return { scenario: "file-optimization", confidence: 0.84 };
  }
  if (hasArchitecture) {
    return { scenario: "architecture", confidence: 0.9 };
  }
  if (/\b(terraform|azure|aks|kubernetes|kubectl|helm|docker|gcloud|aws|github actions|gitlab ci|backup|cluster|infrastructure|deploy)\b/.test(text)) {
    return { scenario: "infrastructure", confidence: 0.93 };
  }
  if (hasDebugging) {
    return { scenario: "debugging", confidence: 0.92 };
  }
  if (/\b(review|audit|analy[sz]e|investigate|security|root cause)\b/.test(text)) {
    return { scenario: "review", confidence: 0.86 };
  }
  return { scenario: "implementation", confidence: 0.72 };
}

export function chooseModelTier(prompt: string): { scenario: ModelScenario; tier: ModelTier; confidence: number } {
  const classified = classifyScenario(prompt);
  const tier: ModelTier = classified.scenario === "quick-edit"
    ? "fast"
    : classified.scenario === "architecture"
      ? "planning"
    : classified.scenario === "debugging" || classified.scenario === "review"
      ? "reasoning"
      : classified.scenario === "infrastructure" || classified.scenario === "audit"
        ? "reasoning"
      : prompt.length > 1200 ? "reasoning" : "balanced";
  return { ...classified, tier };
}

function modelName(tier: ModelTier): string {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.modelRouting");
  return cfg.get<string>(tier, tier);
}

export function recordModelRoutingDecision(target: string, decision: ModelRoutingDecision): void {
  try {
    const file = path.join(target, LOG_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(decision) + "\n", "utf-8");
  } catch { /* non-fatal */ }
}

/**
 * Returns agent-visible context suggesting the user consider a stronger model tier for
 * this task — or "" when there's nothing worth surfacing.
 *
 * Previously asked the agent to "use this tier silently" — there is no hook-level
 * mechanism for a UserPromptSubmit hook to actually change which model is running a
 * session, so that instruction was unactionable by design. It fired on every single
 * prompt (confirmed live: 44 real, silently-ineffective decisions recorded in this
 * repo's own model-routing.jsonl by the time this was found) with, as far as could be
 * determined, zero real effect. Now: only returns text for the tiers where model choice
 * plausibly matters most (reasoning/planning) at high confidence, and asks the agent to
 * surface a brief, one-time, human-actionable suggestion instead of attempting to act on
 * it itself — reducing both the false "this does something" signal and the per-prompt
 * token/context cost of injecting a block that, for most prompts, suggested nothing
 * anyone could use anyway.
 */
export function modelRoutingContext(target: string, agent: string, prompt: string): string {
  if (!modelRoutingEnabled() || !prompt.trim()) return "";
  const decision = chooseModelTier(prompt);
  const worthSurfacing =
    (decision.tier === "reasoning" || decision.tier === "planning") && decision.confidence >= 0.85;
  recordModelRoutingDecision(target, {
    ts: new Date().toISOString(), agent, scenario: decision.scenario,
    tier: decision.tier, confidence: decision.confidence, promptLength: prompt.length,
  });
  if (!worthSurfacing) return "";
  const model = modelName(decision.tier);
  return `[Claude Skills model-tier suggestion: this looks like a ${decision.scenario} task (${Math.round(decision.confidence * 100)}% confidence). A stronger model ("${model}") may give better results here. There is no mechanism for you to switch models yourself — if this seems relevant, mention it to the user once, briefly, rather than acting on it silently.]`;
}
