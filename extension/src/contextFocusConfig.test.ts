import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_FOCUS_LEVELS,
  effectiveContextFocusLevel,
  nextContextFocusLevel,
  syncContextFocusConfigToDisk,
  CONTEXT_FOCUS_CONFIG_PATH,
  type ContextFocusConfig,
} from "./contextFocusConfig";
import * as fs from "node:fs";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    }),
  },
}));

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: () => true,
}));

const baseConfig = (): ContextFocusConfig => ({
  enabled: true,
  level: "balanced",
  autoEscalateOnSessionSize: true,
  injectEveryPrompt: true,
  limitSkillCatalogHints: true,
  manySkillsThreshold: 12,
});

describe("contextFocusConfig", () => {
  it("cycles through focus levels", () => {
    expect(nextContextFocusLevel("knowledge")).toBe("balanced");
    expect(nextContextFocusLevel("strict-local")).toBe("knowledge");
  });

  it("escalates one step on warn session size", () => {
    const cfg = { ...baseConfig(), level: "balanced" as const };
    expect(effectiveContextFocusLevel(cfg, "ok")).toBe("balanced");
    expect(effectiveContextFocusLevel(cfg, "warn")).toBe("local-first");
  });

  it("forces strict-local on critical session size", () => {
    const cfg = { ...baseConfig(), level: "knowledge" as const };
    expect(effectiveContextFocusLevel(cfg, "critical")).toBe("strict-local");
  });

  it("does not escalate when autoEscalate is off", () => {
    const cfg = { ...baseConfig(), level: "knowledge" as const, autoEscalateOnSessionSize: false };
    expect(effectiveContextFocusLevel(cfg, "critical")).toBe("knowledge");
  });

  it("defines four ordered levels", () => {
    expect(CONTEXT_FOCUS_LEVELS).toEqual(["knowledge", "balanced", "local-first", "strict-local"]);
  });

  it("sync respects feature flag via enabled field on disk", () => {
    try {
      syncContextFocusConfigToDisk();
      const raw = JSON.parse(fs.readFileSync(CONTEXT_FOCUS_CONFIG_PATH, "utf-8")) as { enabled: boolean };
      expect(raw.enabled).toBe(true);
    } finally {
      try {
        fs.rmSync(CONTEXT_FOCUS_CONFIG_PATH, { force: true });
      } catch {
        // ignore
      }
    }
  });
});
