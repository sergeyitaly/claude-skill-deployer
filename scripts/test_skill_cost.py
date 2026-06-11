#!/usr/bin/env python3
"""Benchmark skill cost from runs.jsonl (empirical, no live API calls)."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cost_utils import BLENDED_USD_PER_M_TOKEN  # noqa: E402

MANIFEST_PATH = ROOT / "skills_library" / "manifest.json"
RUNS = Path(".claude") / "learning" / "runs.jsonl"


def load_runs(target: Path, skill_name: str) -> list[dict]:
    runs_file = target / RUNS
    if not runs_file.exists():
        return []
    rows = []
    for line in runs_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if row.get("skill") == skill_name:
                rows.append(row)
        except json.JSONDecodeError:
            continue
    return rows


def benchmark_skill_cost(skill_name: str, target: Path, iterations: int = 5) -> float:
    runs = load_runs(target, skill_name)[-iterations:]
    costs = []
    for row in runs:
        if row.get("cost") is not None:
            costs.append(float(row["cost"]))
        elif row.get("tokens"):
            costs.append((int(row["tokens"]) / 1_000_000) * BLENDED_USD_PER_M_TOKEN)

    if not costs:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        tier = manifest.get("skills", {}).get(skill_name, {}).get("cost_estimate", "medium")
        from cost_utils import session_cost_usd, parse_tier  # noqa: E402

        return session_cost_usd(parse_tier(tier))

    return sum(costs) / len(costs)


def update_manifest(skill_name: str, empirical: float, sample_size: int) -> None:
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    rule = data.setdefault("skills", {}).setdefault(skill_name, {})
    rule["empirical_cost"] = round(empirical, 4)
    rule["sample_size"] = sample_size
    rule["last_tested"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    MANIFEST_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("skill")
    parser.add_argument("--target", type=Path, default=Path.cwd())
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--write-manifest", action="store_true")
    args = parser.parse_args()

    target = args.target.resolve()
    avg = benchmark_skill_cost(args.skill, target, args.iterations)
    runs = load_runs(target, args.skill)
    sample = min(len(runs), args.iterations)

    print(f"{args.skill}: ${avg:.4f} avg over {sample} run(s) from runs.jsonl")
    if args.write_manifest and args.skill in json.loads(MANIFEST_PATH.read_text())["skills"]:
        update_manifest(args.skill, avg, sample)
        print(f"Updated manifest empirical_cost for {args.skill}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
