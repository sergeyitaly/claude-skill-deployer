/** Shared cost estimate helpers — not actual API billing. */

export const ESTIMATE_DISCLAIMER =
  "All dollar amounts are model-based estimates from session transcripts and runs.jsonl — not your Anthropic/Cursor invoice. Pro/Max plans are flat-rate.";

export const ESTIMATE_DISCLAIMER_SHORT = "Estimates only — not an API bill";

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING_TIERS: { match: string; pricing: ModelPricing }[] = [
  { match: "opus", pricing: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { match: "haiku", pricing: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { match: "sonnet", pricing: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
];

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

/** @deprecated Blended fallback when model unknown (Sonnet-ish 50/50 input/output). */
export const BLENDED_USD_PER_M_TOKEN = 9;

export function pricingForModel(model?: string): ModelPricing {
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
    cacheReadTokens?: number;
  },
  model?: string
): number {
  const pricing = pricingForModel(model);
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * pricing.input +
    ((usage.outputTokens ?? 0) / 1_000_000) * pricing.output +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * pricing.cacheWrite +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead
  );
}

export function tokenCostUsd(tokens: number, model?: string): number {
  if (tokens <= 0) {
    return 0;
  }
  return (tokens / 1_000_000) * blendedUsdPerMTokens(model);
}

export function formatModelRateHint(model?: string): string {
  const p = pricingForModel(model);
  return `~$${p.input}/M in + $${p.output}/M out (${model ?? "default sonnet"})`;
}
