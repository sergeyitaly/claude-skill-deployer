#!/usr/bin/env python3
"""Real per-agent billing from provider APIs (Python stdlib HTTP only — no LLM calls).

Agents supported when credentials are configured:
  claude  — Anthropic Admin API (sk-ant-admin...) cost_report + usage_report
  cursor  — Cursor Teams Admin API (CURSOR_ADMIN_API_KEY) filtered-usage-events
  copilot — GitHub org Copilot billing/seats API (GITHUB_TOKEN + GITHUB_ORG)
  kiro    — no public API (reported as unavailable)

Environment variables:
  ANTHROPIC_ADMIN_API_KEY   Admin key from console.anthropic.com (not sk-ant-api03)
  CURSOR_ADMIN_API_KEY      Team admin key (Business/Enterprise)
  GITHUB_TOKEN              PAT with manage_billing:copilot or read:org
  GITHUB_ORG                Organization slug for Copilot billing
  COPILOT_SEAT_PRICE_USD    Monthly seat price for Copilot estimate (default 19)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from agent_billing import AgentBillingResult, fetch_all_agent_billing  # noqa: E402
from cost_utils import format_usd  # noqa: E402


def _kind_label(kind: str) -> str:
    return {
        "invoice_usd": "API invoice (USD)",
        "subscription_seats": "Seat subscription",
        "usage_only": "Usage metrics only",
        "unavailable": "Unavailable",
    }.get(kind, kind)


def result_to_dict(row: AgentBillingResult) -> dict:
    return {
        "agent": row.agent,
        "display_name": row.display_name,
        "status": row.status,
        "kind": row.kind,
        "cost_usd": row.cost_usd,
        "currency": row.currency,
        "period_days": row.period_days,
        "message": row.message,
        "source": row.source,
        "models": [
            {"model": m.model, "cost_usd": m.cost_usd, "tokens": m.tokens}
            for m in row.models
        ],
        "extra": row.extra,
    }


def print_report(rows: list[AgentBillingResult]) -> None:
    print("Agent billing report (provider APIs — not LLM estimates)")
    print()
    print(f"{'Agent':<10} {'Status':<8} {'Kind':<22} {'Cost':>12}  Notes")
    print("-" * 90)
    for row in rows:
        cost = format_usd(row.cost_usd) if row.cost_usd is not None else "n/a"
        note = row.message[:48] + ("..." if len(row.message) > 48 else "")
        print(f"{row.agent:<10} {row.status:<8} {_kind_label(row.kind):<22} {cost:>12}  {note}")

    print()
    for row in rows:
        if row.status != "ok" or not row.models:
            continue
        print(f"{row.display_name} — per model ({row.period_days}d):")
        print(f"  {'Model':<36} {'Tokens':>12} {'Cost':>10}")
        for m in row.models[:20]:
            tok = f"{m.tokens:,}" if m.tokens else "-"
            print(f"  {m.model:<36} {tok:>12} {format_usd(m.cost_usd):>10}")
        if len(row.models) > 20:
            print(f"  ... and {len(row.models) - 20} more models")
        print()

    configured = [r.agent for r in rows if r.status == "ok"]
    skipped = [r.agent for r in rows if r.status == "skipped"]
    errors = [r.agent for r in rows if r.status == "error"]
    print("Summary:")
    if configured:
        print(f"  Live API data: {', '.join(configured)}")
    if skipped:
        print(f"  Skipped (set env vars): {', '.join(skipped)}")
    if errors:
        print(f"  Errors: {', '.join(errors)}")
    print()
    print("Setup cheatsheet:")
    print("  Claude:  ANTHROPIC_ADMIN_API_KEY=sk-ant-admin...  (Console -> Admin keys)")
    print("  Cursor:  CURSOR_ADMIN_API_KEY=...                 (Teams settings -> Admin API)")
    print("  Copilot: GITHUB_TOKEN=ghp_... GITHUB_ORG=my-org   (org owner + Copilot plan)")
    print("  Kiro:    no API")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="Lookback window (default 7)")
    parser.add_argument(
        "--agents",
        nargs="*",
        choices=["claude", "cursor", "kiro", "copilot"],
        help="Subset of agents (default: all)",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    args = parser.parse_args()

    rows = fetch_all_agent_billing(days_back=args.days, agents=args.agents)
    if args.json:
        print(json.dumps([result_to_dict(r) for r in rows], indent=2))
    else:
        print_report(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
