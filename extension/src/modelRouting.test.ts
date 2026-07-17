import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseModelTier, modelRoutingContext } from "./modelRouting";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-routing-"));
  workspaces.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workspaces) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("model routing scenarios from README workflows", () => {
  it("routes infrastructure work to reasoning", () => {
    expect(chooseModelTier("Deploy AKS with Terraform and diagnose kubectl readiness")).toMatchObject({
      scenario: "infrastructure", tier: "reasoning",
    });
  });

  it("routes architecture and migration work to planning", () => {
    expect(chooseModelTier("Design a migration strategy from App Service to AKS")).toMatchObject({
      scenario: "architecture", tier: "planning",
    });
  });

  it("routes audits to reasoning", () => {
    expect(chooseModelTier("Export telemetry for a client compliance audit")).toMatchObject({
      scenario: "audit", tier: "reasoning",
    });
  });

  it("routes cost and HACE analysis to balanced", () => {
    expect(chooseModelTier("Review ROI, spend, and HACE trends")).toMatchObject({
      scenario: "cost-analysis", tier: "balanced",
    });
  });

  it("routes prompt coaching to balanced", () => {
    expect(chooseModelTier("Rewrite this vague multi-goal prompt with success criteria")).toMatchObject({
      scenario: "prompt-coaching", tier: "balanced",
    });
  });

  it("routes small edits to fast", () => {
    expect(chooseModelTier("Rename this variable and fix the typo")).toMatchObject({
      scenario: "quick-edit", tier: "fast",
    });
  });
});

describe("modelRoutingContext (regression: no more unactionable 'use silently' instruction)", () => {
  it("returns a human-actionable suggestion for a high-confidence planning-tier prompt, not an instruction to self-switch", () => {
    const target = makeWorkspace();
    const result = modelRoutingContext(target, "claude", "Design a migration strategy from App Service to AKS");

    expect(result).not.toBe("");
    expect(result).not.toContain("Use this tier silently");
    expect(result).toContain("no mechanism for you to switch models");
    expect(result).toContain("mention it to the user");
  });

  it("returns nothing for a fast/quick-edit prompt — not worth surfacing", () => {
    const target = makeWorkspace();
    const result = modelRoutingContext(target, "claude", "Rename this variable and fix the typo");

    expect(result).toBe("");
  });

  it("returns nothing for a balanced-tier prompt even though it still records the decision", () => {
    const target = makeWorkspace();
    const result = modelRoutingContext(target, "claude", "Review ROI, spend, and HACE trends");

    expect(result).toBe("");
    const log = fs.readFileSync(path.join(target, ".claude", "learning", "model-routing.jsonl"), "utf-8");
    expect(log).toContain("cost-analysis");
  });

  it("still records every decision to model-routing.jsonl regardless of whether anything is surfaced", () => {
    const target = makeWorkspace();
    modelRoutingContext(target, "claude", "Design a migration strategy from App Service to AKS");
    modelRoutingContext(target, "claude", "Rename this variable and fix the typo");

    const lines = fs
      .readFileSync(path.join(target, ".claude", "learning", "model-routing.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
  });
});
