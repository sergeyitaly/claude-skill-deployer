import * as path from "node:path";
import { ModelPricing } from "./costRates";
import { readJsonFile, writeJsonAtomic } from "./fileWriteCoordination";

export interface PricingOverridesFile {
  version: 1;
  /** USD per 1M tokens — keys are model id substrings (same matching as costRates). */
  models?: Record<string, ModelPricing>;
  /** ROI hourly rate override (default 75). */
  defaultHourlyRateUsd?: number;
  updatedAt?: string;
}

export function pricingOverridesPath(target: string): string {
  return path.join(target, ".claude", "learning", "pricing-overrides.json");
}

export function readPricingOverrides(target?: string): PricingOverridesFile | undefined {
  if (!target) {
    return undefined;
  }
  const parsed = readJsonFile<PricingOverridesFile>(pricingOverridesPath(target));
  if (!parsed || parsed.version !== 1) {
    return undefined;
  }
  return parsed;
}

export function writePricingOverrides(target: string, overrides: PricingOverridesFile): void {
  writeJsonAtomic(pricingOverridesPath(target), {
    ...overrides,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
}

/** Resolve override pricing for a model id, if configured in workspace. */
export function overridePricingForModel(model: string | undefined, target?: string): ModelPricing | undefined {
  const file = target ? readPricingOverrides(target) : undefined;
  if (!file?.models) {
    return undefined;
  }
  const lower = (model ?? "").toLowerCase();
  for (const [key, pricing] of Object.entries(file.models)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return pricing;
    }
  }
  return undefined;
}

export function defaultHourlyRateUsd(target?: string): number {
  const file = target ? readPricingOverrides(target) : undefined;
  const rate = file?.defaultHourlyRateUsd;
  return typeof rate === "number" && rate > 0 ? rate : 75;
}
