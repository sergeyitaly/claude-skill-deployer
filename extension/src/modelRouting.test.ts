import { describe, expect, it } from "vitest";
import { chooseModelTier } from "./modelRouting";

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
