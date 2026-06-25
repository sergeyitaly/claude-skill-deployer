/** Shared cost estimate helpers — not actual API billing. */

import { overridePricingForModel, defaultHourlyRateUsd } from "./pricingOverrides";

export const ESTIMATE_DISCLAIMER =
  "All dollar amounts are model-based estimates from session transcripts and runs.jsonl — not your Anthropic/Cursor invoice. Pro/Max plans are flat-rate. " +
  "When only a token count is available (no caller-provided cost), blended rates (~$9/M tokens) are used; this can differ from actual API costs by ~10% due to model-mix and cache factors. " +
  "Runs logged with cost_source=\"caller\" use the exact cost reported by the invocation hook.";

export const ESTIMATE_DISCLAIMER_SHORT = "Estimates only — not an API bill (~±10% vs actual)";

export interface ModelPricing {
  input: number;
  output: number;
  /** 5-minute TTL cache write (1.25x input). */
  cacheWrite: number;
  /** 1-hour TTL cache write (2x input). Falls back to 2x `input` when absent (e.g. older overrides). */
  cacheWrite1h?: number;
  cacheRead: number;
}

const PRICING_TIERS: { match: string; pricing: ModelPricing }[] = [
  { match: "fable", pricing: { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1 } },
  { match: "mythos", pricing: { input: 10, output: 50, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1 } },
  { match: "opus", pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
  { match: "haiku", pricing: { input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 } },
  { match: "sonnet", pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
];

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };

/** Active workspace for pricing-overrides.json lookup (set by extension on refresh). */
let activePricingTarget: string | undefined;

export function setPricingContext(target: string | undefined): void {
  activePricingTarget = target;
}

/** @deprecated Blended fallback when model unknown (Sonnet-ish 50/50 input/output). */
export const BLENDED_USD_PER_M_TOKEN = 9;

export function pricingForModel(model?: string): ModelPricing {
  const override = overridePricingForModel(model, activePricingTarget);
  if (override) {
    return override;
  }
  const lower = (model ?? "claude-sonnet").toLowerCase();
  for (const tier of PRICING_TIERS) {
    if (lower.includes(tier.match)) {
      return tier.pricing;
    }
  }
  return DEFAULT_PRICING;
}

/** Blended $/M tokens for a total count when input/output split is unknown. */
export function blendedUsdPerMTokens(model?: string): number {
  const p = pricingForModel(model);
  return (p.input + p.output) / 2;
}

export function estimateUsageCostUsd(
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    /** Portion of `cacheCreationTokens` written with a 1-hour TTL (priced at `cacheWrite1h`). */
    cacheCreation1hTokens?: number;
    cacheReadTokens?: number;
  },
  model?: string
): number {
  const pricing = pricingForModel(model);
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const cache1h = Math.min(usage.cacheCreation1hTokens ?? 0, cacheCreationTokens);
  const cache5m = cacheCreationTokens - cache1h;
  const cacheWrite1h = pricing.cacheWrite1h ?? pricing.input * 2;
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * pricing.input +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.output +
    (cache5m / 1_000_000) * pricing.cacheWrite +
    (cache1h / 1_000_000) * cacheWrite1h +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead
  );
}

/** Usage block as logged in Claude session transcripts (snake_case). */
export function estimateUsageCostFromRaw(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        /** Flat 1h-cache portion (as carried in runs.jsonl `metadata.usage`). */
        cache_creation_input_tokens_1h?: number;
        /** Nested breakdown as logged in raw Claude session transcripts. */
        cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
        cache_read_input_tokens?: number;
      }
    | undefined,
  model?: string
): number {
  if (!usage) {
    return 0;
  }
  return estimateUsageCostUsd(
    {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheCreation1hTokens: usage.cache_creation_input_tokens_1h ?? usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    },
    model
  );
}

export function tokenCostUsd(tokens: number, model?: string): number {
  if (tokens <= 0) {
    return 0;
  }
  return (tokens / 1_000_000) * blendedUsdPerMTokens(model);
}

export function hourlyRateUsd(): number {
  return defaultHourlyRateUsd(activePricingTarget);
}

export function formatModelRateHint(model?: string): string {
  const p = pricingForModel(model);
  return `~$${p.input}/M in + $${p.output}/M out (${model ?? "default sonnet"})`;
}
