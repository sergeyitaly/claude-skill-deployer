#!/usr/bin/env python3
"""Per-skill cost report from runs.jsonl — hook-grounded, model-aware (not flat $9/M)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cost_utils import format_usd  # noqa: E402
from runs_cost import RunsCostSummary, summarize_skill_costs  # noqa: E402


def _format_tokens(tokens: int) -> str:
    if tokens >= 1_000_000:
        return f"{tokens / 1_000_000:.2f}M"
    if tokens >= 1_000:
        return f"{tokens / 1_000:.1f}K"
    return str(tokens)


def print_report(summary: RunsCostSummary, *, show_all: bool) -> None:
    mode = "hook + self-learning rows" if summary.hook_only else "all usage rows"
    if summary.period_days:
        print(f"Period: last {summary.period_days} days")
    print(f"Workspace: {summary.workspace}")
    print(f"Source: {summary.runs_file}")
    print(f"Mode: {mode}")
    print()
    print(f"Included runs: {summary.included_runs}")
    if summary.excluded_collector_runs:
        print(
            f"Excluded attribution-collector transcript rows: {summary.excluded_collector_runs} "
            "(session-level estimates - not per-invoke cost)"
        )
    if summary.duplicate_collector_runs:
        print(f"Deduped duplicate collector rows: {summary.duplicate_collector_runs}")
    print()
    print(f"Tokens (included): {_format_tokens(summary.total_tokens)}")
    print(f"Stored cost in runs.jsonl: {format_usd(summary.stored_cost_total)}")
    print(f"Computed cost (model-aware): {format_usd(summary.computed_cost_total)}")
    delta = summary.computed_cost_total - summary.stored_cost_total
    if abs(delta) >= 0.01:
        sign = "+" if delta > 0 else ""
        print(f"Delta (computed - stored): {sign}{format_usd(delta)}")
    print()
    print("Per skill (computed cost):")
    print(f"{'Skill':<32} {'Runs':>5} {'Hook':>5} {'Tokens':>10} {'Stored':>10} {'Computed':>10}")
    print("-" * 78)
    rows = summary.by_skill if show_all else summary.by_skill[:25]
    for row in rows:
        print(
            f"{row.skill:<32} {row.runs:>5} {row.hook_runs:>5} "
            f"{_format_tokens(row.tokens):>10} {format_usd(row.stored_cost):>10} "
            f"{format_usd(row.computed_cost):>10}"
        )
    if not show_all and len(summary.by_skill) > 25:
        print(f"... and {len(summary.by_skill) - 25} more (use --all)")
    if summary.by_model:
        print()
        print("Per model (computed cost):")
        print(f"{'Model':<36} {'Runs':>5} {'Usage':>5} {'Tokens':>10} {'Computed':>10}")
        print("-" * 72)
        model_rows = summary.by_model if show_all else summary.by_model[:15]
        for row in model_rows:
            print(
                f"{row.model:<36} {row.runs:>5} {row.usage_breakdown_runs:>5} "
                f"{_format_tokens(row.tokens):>10} {format_usd(row.computed_cost):>10}"
            )
        if not show_all and len(summary.by_model) > 15:
            print(f"... and {len(summary.by_model) - 15} more models (use --all)")
    print()
    print(
        "Note: Computed costs use Anthropic list pricing (input/output/cache) when usage "
        "breakdown is available; otherwise model-tier blended rates. This is still an "
        "estimate - not your invoice. Hook rows are the most accurate per-skill signal."
    )


def summary_to_json(summary: RunsCostSummary) -> dict:
    return {
        "workspace": summary.workspace,
        "runs_file": summary.runs_file,
        "period_days": summary.period_days,
        "included_runs": summary.included_runs,
        "excluded_collector_runs": summary.excluded_collector_runs,
        "duplicate_collector_runs": summary.duplicate_collector_runs,
        "total_tokens": summary.total_tokens,
        "stored_cost_total": round(summary.stored_cost_total, 6),
        "computed_cost_total": round(summary.computed_cost_total, 6),
        "hook_only": summary.hook_only,
        "skills": [
            {
                "skill": row.skill,
                "runs": row.runs,
                "hook_runs": row.hook_runs,
                "tokens": row.tokens,
                "stored_cost": round(row.stored_cost, 6),
                "computed_cost": round(row.computed_cost, 6),
                "cost_methods": row.methods,
            }
            for row in summary.by_skill
        ],
        "models": [
            {
                "model": row.model,
                "runs": row.runs,
                "usage_breakdown_runs": row.usage_breakdown_runs,
                "tokens": row.tokens,
                "stored_cost": round(row.stored_cost, 6),
                "computed_cost": round(row.computed_cost, 6),
            }
            for row in summary.by_model
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", type=Path, default=Path.cwd(), help="Workspace root")
    parser.add_argument("--days", type=int, default=None, help="Only include runs from the last N days")
    parser.add_argument(
        "--include-transcript",
        action="store_true",
        help="Include attribution-collector transcript rows (often inflates totals; deduped by session)",
    )
    parser.add_argument(
        "--all-runs",
        action="store_true",
        help="Include all usage rows, not only hook/self-learning",
    )
    parser.add_argument(
        "--enrich-transcripts",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Resolve hook tool_use_id usage from session transcripts (default: on)",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    parser.add_argument("--all", action="store_true", help="Show all skills in table output")
    args = parser.parse_args()

    target = args.target.resolve()
    summary = summarize_skill_costs(
        target,
        days=args.days,
        hook_only=not args.all_runs,
        include_transcript=args.include_transcript,
        enrich_transcripts=args.enrich_transcripts,
    )

    if args.json:
        print(json.dumps(summary_to_json(summary), indent=2))
    else:
        print_report(summary, show_all=args.all)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
