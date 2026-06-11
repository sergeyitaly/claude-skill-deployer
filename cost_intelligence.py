#!/usr/bin/env python3
"""Cost intelligence helpers for generate_skills.py CLI."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cost_utils import BLENDED_USD_PER_M_TOKEN, format_usd

ATTRIBUTION_PATH = Path.home() / ".claude" / "learning" / "cost-attribution.json"
RUNS_RELATIVE = Path(".claude") / "learning" / "runs.jsonl"
COST_PROFILES_PATH = Path.home() / ".claude" / "learning" / "cost-profiles.json"


def _skill_total_cost(agent_data: dict) -> float:
    return sum((a or {}).get("cost", 0) for a in agent_data.values())


def _merge_attribution(data: dict) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for key in ("skills", "transcriptSkills"):
        block = data.get(key) or {}
        for skill, agents in block.items():
            bucket = merged.setdefault(skill, {})
            for agent, stats in (agents or {}).items():
                cur = bucket.setdefault(agent, {"tokens": 0, "cost": 0, "sessions": 0})
                cur["tokens"] += stats.get("tokens", 0)
                cur["cost"] += stats.get("cost", 0)
                cur["sessions"] += stats.get("sessions", 0)
    return merged


def load_cost_attribution() -> dict:
    if not ATTRIBUTION_PATH.exists():
        return {"skills": {}, "total_cost": 0.0, "top_skill": None}
    try:
        data = json.loads(ATTRIBUTION_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"skills": {}, "total_cost": 0.0, "top_skill": None}

    merged = _merge_attribution(data)
    totals = sorted(
        ((skill, _skill_total_cost(agents)) for skill, agents in merged.items()),
        key=lambda x: x[1],
        reverse=True,
    )
    total_cost = sum(c for _, c in totals)
    top_skill = totals[0][0] if totals else None
    return {
        "skills": merged,
        "total_cost": total_cost,
        "top_skill": top_skill,
        "base_context": data.get("base_context", {}),
    }


def _usage_counts(target: Path) -> dict[str, int]:
    runs_file = target / RUNS_RELATIVE
    counts: dict[str, int] = {}
    if not runs_file.exists():
        return counts
    for line in runs_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            skill = row.get("skill")
            if skill:
                counts[skill] = counts.get(skill, 0) + 1
        except json.JSONDecodeError:
            continue
    return counts


def generate_suggestions(attribution: dict, target: Path) -> list[dict]:
    suggestions: list[dict] = []
    usage = _usage_counts(target)
    skills = attribution.get("skills") or {}

    for skill, agents in skills.items():
        total = _skill_total_cost(agents)
        if total <= 0:
            continue
        runs = max(1, usage.get(skill, 0))
        cost_per_use = total / runs
        if cost_per_use > 1.0 and runs < 5:
            suggestions.append({
                "type": "disable",
                "skill": skill,
                "action": f'Disable "{skill}"',
                "description": f'Disable "{skill}" (${cost_per_use:.2f}/use, {runs} runs)',
                "savings": total,
            })

        claude = agents.get("claude") or {}
        cursor = agents.get("cursor") or {}
        if claude.get("sessions", 0) > 0 and cursor.get("sessions", 0) > 0:
            claude_per = claude["cost"] / claude["sessions"]
            cursor_per = cursor["cost"] / cursor["sessions"]
            if cursor_per < claude_per * 0.7:
                suggestions.append({
                    "type": "switch_agent",
                    "skill": skill,
                    "action": f'Prefer Cursor for "{skill}"',
                    "description": f'Use Cursor for "{skill}" (save ~${claude_per - cursor_per:.2f}/run)',
                    "savings": claude_per - cursor_per,
                })

    suggestions.sort(key=lambda s: s.get("savings", 0), reverse=True)
    return suggestions


def weekly_summary_from_runs(target: Path) -> dict:
    runs_file = target / RUNS_RELATIVE
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    two_weeks = now - timedelta(days=14)
    this_week = 0.0
    last_week = 0.0
    tokens = 0

    if runs_file.exists():
        for line in runs_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                ts = datetime.fromisoformat((row.get("ts") or row.get("timestamp", "")).replace("Z", "+00:00"))
                cost = row.get("cost")
                if cost is None:
                    cost = (row.get("tokens") or 0) / 1_000_000 * BLENDED_USD_PER_M_TOKEN
                if ts >= week_ago:
                    this_week += cost
                    tokens += row.get("tokens") or 0
                elif ts >= two_weeks:
                    last_week += cost
            except (json.JSONDecodeError, ValueError, TypeError):
                continue

    pct = 0.0
    if last_week > 0:
        pct = ((this_week - last_week) / last_week) * 100

    attr = load_cost_attribution()
    top = sorted(
        ((s, _skill_total_cost(a)) for s, a in attr.get("skills", {}).items()),
        key=lambda x: x[1],
        reverse=True,
    )[:5]

    return {
        "total": this_week,
        "total_tokens": int(tokens),
        "vs_last_week_percent": pct,
        "top_skills": [{"name": n, "cost": c} for n, c in top],
        "optimizations": generate_suggestions(attr, target),
    }


def print_cost_report(target: Path) -> int:
    attr = load_cost_attribution()
    suggestions = generate_suggestions(attr, target)

    print("\nCost Intelligence Report")
    print(f"Attributed total: {format_usd(attr['total_cost'])}")
    if attr.get("top_skill"):
        print(f"Most expensive: {attr['top_skill']}")

    if suggestions:
        print("\nOptimizations:")
        for s in suggestions[:5]:
            print(f"  - {s['description']}")
    else:
        print("\nNo optimizations yet — need more runs.jsonl / transcript data.")

    print("\nRun with: generate_skills.py cost-report --apply-optimizations (extension applies interactively)")
    return 0
