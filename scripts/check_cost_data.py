#!/usr/bin/env python3
"""Validate cost intelligence data vs transcript ground truth."""
from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path

LEGACY_ATTR_PATH = Path.home() / ".claude" / "learning" / "cost-attribution.json"
COST_PER_M = 9.0


def attr_path_for(workspace: Path | None) -> Path:
    if workspace:
        return workspace / ".claude" / "learning" / "cost-attribution.json"
    return LEGACY_ATTR_PATH


def sum_transcript_tokens() -> tuple[int, int]:
    roots = [
        Path.home() / ".claude" / "projects",
        Path.home() / ".cursor" / "projects",
    ]
    files: list[Path] = []
    for root in roots:
        if root.is_dir():
            files.extend(root.rglob("*.jsonl"))
    total = 0
    for fp in files:
        try:
            text = fp.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line in text.splitlines():
            if '"usage"' not in line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            usage = (parsed.get("message") or {}).get("usage") or parsed.get("usage") or {}
            total += (
                int(usage.get("input_tokens") or 0)
                + int(usage.get("output_tokens") or 0)
                + int(usage.get("cache_read_input_tokens") or 0)
                + int(usage.get("cache_creation_input_tokens") or 0)
            )
    return total, len(files)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default=os.getcwd(), help="Workspace root for per-project attribution file")
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    attr_path = attr_path_for(workspace)

    print("=== Cost data sanity check ===\n")
    print(f"Workspace: {workspace}")
    print(f"Attribution file: {attr_path}\n")

    transcript_tokens, file_count = sum_transcript_tokens()
    transcript_cost = transcript_tokens / 1_000_000 * COST_PER_M
    print(f"Transcript files scanned: {file_count}")
    print(f"Machine-wide transcript tokens (all projects): {transcript_tokens / 1e6:.1f}M")
    print(f"Estimated cost at ${COST_PER_M}/M (extension formula): ${transcript_cost:,.2f}")
    print("(This is NOT your real API bill — rough estimate from session logs.)\n")

    if not attr_path.is_file() and LEGACY_ATTR_PATH.is_file():
        try:
            legacy = json.loads(LEGACY_ATTR_PATH.read_text(encoding="utf-8"))
            legacy_ws = legacy.get("workspacePath")
            if not legacy_ws or Path(legacy_ws).resolve() == workspace:
                attr_path.parent.mkdir(parents=True, exist_ok=True)
                attr_path.write_text(LEGACY_ATTR_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        except (json.JSONDecodeError, OSError):
            pass

    if not attr_path.exists():
        print(f"Missing: {attr_path}")
        return

    attr = json.loads(attr_path.read_text(encoding="utf-8"))
    ts = attr.get("transcriptSkills") or attr.get("skills") or {}
    print(f"cost-attribution.json updated: {attr.get('updatedAt')}")
    print(f"Attributed skills count: {len(ts)}\n")

    by_cost: dict[float, list[str]] = defaultdict(list)
    sum_skill_cost = 0.0
    sum_skill_tokens = 0.0
    for name, agents in ts.items():
        claude = agents.get("claude") or {}
        cost = float(claude.get("cost") or 0)
        tokens = float(claude.get("tokens") or 0)
        sum_skill_cost += cost
        sum_skill_tokens += tokens
        by_cost[round(cost, 2)].append(name)

    print(f"Sum of per-skill attributed costs (claude): ${sum_skill_cost:,.2f}")
    print(f"Sum of per-skill attributed tokens (claude): {sum_skill_tokens / 1e6:.1f}M")
    if sum_skill_cost > transcript_cost * 1.5:
        print("WARNING: Attributed skill costs exceed transcript total — double/triple counting (equal split bug).\n")
    elif sum_skill_tokens > transcript_tokens * 1.5:
        print("WARNING: Attributed skill tokens exceed transcript total — equal split across many skills per session.\n")

    print("Largest cost clusters (identical $ = same sessions split equally):")
    for cost, names in sorted(by_cost.items(), key=lambda x: -x[0])[:6]:
        preview = ", ".join(names[:8])
        extra = f" (+{len(names) - 8} more)" if len(names) > 8 else ""
        print(f"  ${cost:,.2f} × {len(names)} skills: {preview}{extra}")

    unattributed = attr.get("unattributed") or {}
    if unattributed:
        print(f"\nUnattributed tokens: {unattributed}")
    else:
        print("\nUnattributed: (empty — sessions forced into skill buckets)")

    project_skills = {
        p.name
        for p in (Path(__file__).resolve().parent.parent / "skills_library").iterdir()
        if p.is_dir() and (p / "SKILL.md").exists()
    }
    builtin_like = [n for n in ts if n not in project_skills and len(n) <= 3 or n in {
        "claude-api", "loop", "simplify", "init", "review", "run", "verify", "schedule",
        "fewer-permission-prompts", "keybindings-help", "update-config", "codemie", "code-review",
    }]
    print(f"\nLikely non-project / built-in skill keys in attribution: {len(builtin_like)}")
    print("  " + ", ".join(sorted(set(builtin_like))[:20]))

    print("\nRecommended: Command Palette -> Claude Skills: Reset Mis-attributed Cost Data")
    print("Then let the collector re-run with v1.0.1+ attribution (invoked skills only).")


if __name__ == "__main__":
    main()
