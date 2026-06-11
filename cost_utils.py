"""Shared cost estimate helpers for generate_skills.py (mirrors extension/src/skillCost.ts)."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

TIER_SESSION_TOKENS = {"low": 8_000, "medium": 25_000, "high": 80_000}
BLENDED_USD_PER_M_TOKEN = 9.0
HIGH_TIER_BUDGET_RESERVE_USD = 1.0

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
