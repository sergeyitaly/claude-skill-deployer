"""Shared cost estimate helpers for generate_skills.py (mirrors extension/src/costRates.ts)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import TypedDict

TIER_SESSION_TOKENS = {"low": 8_000, "medium": 25_000, "high": 80_000}
BLENDED_USD_PER_M_TOKEN = 9.0
HIGH_TIER_BUDGET_RESERVE_USD = 1.0

SKILL_INVOKE_HOOK_SOURCE = "skill-invoke-hook-v2"
ATTRIBUTION_COLLECTOR_SOURCE = "attribution-collector"


@dataclass(frozen=True)
class ModelPricing:
    input: float
    output: float
    cache_write: float
    cache_read: float


class UsageBreakdown(TypedDict, total=False):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


PRICING_TIERS: list[tuple[str, ModelPricing]] = [
    ("fable", ModelPricing(10, 50, 12.5, 1)),
    ("mythos", ModelPricing(10, 50, 12.5, 1)),
    ("opus", ModelPricing(5, 25, 6.25, 0.5)),
    ("haiku", ModelPricing(1, 5, 1.25, 0.1)),
    ("sonnet", ModelPricing(3, 15, 3.75, 0.3)),
]

DEFAULT_PRICING = ModelPricing(3, 15, 3.75, 0.3)

BUDGET_PATH = Path.home() / ".claude" / "learning" / "budget.json"
TODAY_COST_PATH = Path.home() / ".claude" / "learning" / "today-cost.json"


def parse_tier(cost_estimate) -> str:
    if isinstance(cost_estimate, dict):
        return str(cost_estimate.get("tier", "medium"))
    if isinstance(cost_estimate, str) and cost_estimate in TIER_SESSION_TOKENS:
        return cost_estimate
    return "medium"


def session_cost_usd(tier: str) -> float:
    tokens = TIER_SESSION_TOKENS.get(tier, TIER_SESSION_TOKENS["medium"])
    return (tokens / 1_000_000) * BLENDED_USD_PER_M_TOKEN


def format_usd(usd: float) -> str:
    if 0 < usd < 0.01:
        return "<$0.01"
    return f"${usd:.2f}"


def read_pricing_overrides(target: Path | str | None) -> dict[str, ModelPricing]:
    if not target:
        return {}
    path = Path(target) / ".claude" / "learning" / "pricing-overrides.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if data.get("version") != 1:
        return {}
    models = data.get("models") or {}
    out: dict[str, ModelPricing] = {}
    for key, raw in models.items():
        if not isinstance(raw, dict):
            continue
        out[key] = ModelPricing(
            float(raw.get("input", DEFAULT_PRICING.input)),
            float(raw.get("output", DEFAULT_PRICING.output)),
            float(raw.get("cacheWrite", raw.get("cache_write", DEFAULT_PRICING.cache_write))),
            float(raw.get("cacheRead", raw.get("cache_read", DEFAULT_PRICING.cache_read))),
        )
    return out


def pricing_for_model(model: str | None, overrides: dict[str, ModelPricing] | None = None) -> ModelPricing:
    lower = (model or "claude-sonnet").lower()
    for key, pricing in (overrides or {}).items():
        key_lower = key.lower()
        if key_lower in lower or lower in key_lower:
            return pricing
    for match, pricing in PRICING_TIERS:
        if match in lower:
            return pricing
    return DEFAULT_PRICING


def blended_usd_per_m_tokens(model: str | None, overrides: dict[str, ModelPricing] | None = None) -> float:
    pricing = pricing_for_model(model, overrides)
    return (pricing.input + pricing.output) / 2


def estimate_usage_cost_usd(
    usage: UsageBreakdown,
    model: str | None = None,
    overrides: dict[str, ModelPricing] | None = None,
) -> float:
    pricing = pricing_for_model(model, overrides)
    return (
        (int(usage.get("input_tokens") or 0) / 1_000_000) * pricing.input
        + (int(usage.get("output_tokens") or 0) / 1_000_000) * pricing.output
        + (int(usage.get("cache_creation_input_tokens") or 0) / 1_000_000) * pricing.cache_write
        + (int(usage.get("cache_read_input_tokens") or 0) / 1_000_000) * pricing.cache_read
    )


def token_cost_usd(
    tokens: int | float,
    model: str | None = None,
    overrides: dict[str, ModelPricing] | None = None,
) -> float:
    if tokens <= 0:
        return 0.0
    return (float(tokens) / 1_000_000) * blended_usd_per_m_tokens(model, overrides)


def read_budget() -> dict:
    if not BUDGET_PATH.exists():
        return {}
    try:
        return json.loads(BUDGET_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def read_today_cost_usd() -> float:
    if not TODAY_COST_PATH.exists():
        return 0.0
    try:
        data = json.loads(TODAY_COST_PATH.read_text(encoding="utf-8"))
        if data.get("date") != date.today().isoformat():
            return 0.0
        return float(data.get("costUsd", 0))
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return 0.0


def remaining_daily_budget_usd() -> float | None:
    budget = read_budget()
    cap = float(budget.get("dailyBudgetUsd", 0) or 0)
    if cap <= 0:
        return None
    return max(0.0, cap - read_today_cost_usd())


def should_skip_expensive_skill(skill_name: str, rule: dict, *, dry_run: bool) -> str | None:
    """Return skip reason, or None if the skill should be installed."""
    if dry_run:
        return None
    tier = parse_tier(rule.get("cost_estimate"))
    if tier != "high":
        return None

    budget = read_budget()
    mode = budget.get("mode", "normal")
    if mode == "economy":
        return "economy mode (high-tier skills disabled)"

    remaining = remaining_daily_budget_usd()
    if remaining is not None and remaining < HIGH_TIER_BUDGET_RESERVE_USD:
        return f"daily budget low (~{format_usd(remaining)} remaining)"

    return None


def print_cost_summary(skill_names: list[str], manifest: dict, *, sessions_per_week: int = 10) -> None:
    if not skill_names:
        return

    print(f"\nWould install {len(skill_names)} skill(s):")
    total = 0.0
    for name in sorted(skill_names):
        rule = manifest["skills"].get(name, {})
        tier = parse_tier(rule.get("cost_estimate"))
        cost = session_cost_usd(tier)
        total += cost
        print(f"  {name} ({tier} cost ~{format_usd(cost)}/session)")

    print(f"\nEstimated session cost: {format_usd(total)}")
    print(f"Estimated weekly ({sessions_per_week} sessions): {format_usd(total * sessions_per_week)}")
    budget = read_budget()
    if budget.get("mode") == "economy":
        print("\nTip: Economy mode is on — high-cost skills may be skipped on install.")
    elif budget.get("dailyBudgetUsd", 0):
        remaining = remaining_daily_budget_usd()
        if remaining is not None:
            print(f"Tip: ~{format_usd(remaining)} of today's budget remaining.")
