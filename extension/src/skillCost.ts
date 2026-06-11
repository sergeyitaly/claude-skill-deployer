/** Qualitative per-skill cost tier from manifest.json. Describes typical
 * context + operational token load when the skill is active in a session. */
export type CostEstimateTier = "low" | "medium" | "high";

/** Approximate tokens loaded per session when a skill is installed and
 * eligible (SKILL.md context + typical tool reads). Used for install previews
 * only — not a bill. */
export const TIER_SESSION_TOKENS: Record<CostEstimateTier, number> = {
  low: 8_000,
  medium: 25_000,
  high: 80_000,
};

/** Sonnet-class reference rate (USD per million tokens, blended input/output). */
const BLENDED_USD_PER_M_TOKEN = 0.009;

export function tierForSkill(costEstimate: CostEstimateTier | undefined): CostEstimateTier {
  return costEstimate ?? "medium";
}

export function estimateSessionTokens(tier: CostEstimateTier): number {
  return TIER_SESSION_TOKENS[tier];
}

export function estimateSessionCostUsd(tier: CostEstimateTier): number {
  return (estimateSessionTokens(tier) / 1_000_000) * BLENDED_USD_PER_M_TOKEN;
}

export function sumInstallCostEstimate(tiers: CostEstimateTier[]): { totalTokens: number; totalCostUsd: number } {
  const totalTokens = tiers.reduce((sum, tier) => sum + estimateSessionTokens(tier), 0);
  return {
    totalTokens,
    totalCostUsd: (totalTokens / 1_000_000) * BLENDED_USD_PER_M_TOKEN,
  };
}

export function formatCompactUsd(usd: number): string {
  if (usd < 0.01 && usd > 0) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}
