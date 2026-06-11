#!/usr/bin/env python3
"""Backfill missing agent/session_id/cost fields in .claude/learning/runs.jsonl."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cost_utils import BLENDED_USD_PER_M_TOKEN  # noqa: E402


def token_cost_usd(tokens: int) -> float:
    return (tokens / 1_000_000) * BLENDED_USD_PER_M_TOKEN


def infer_agent(run: dict) -> str:
    if run.get("agent"):
        return run["agent"]
    transcript = str(run.get("transcript_path", ""))
    project = str(run.get("project", ""))
    if ".cursor" in transcript or ".cursor" in project:
        return "cursor"
    if ".kiro" in transcript or ".kiro" in project:
        return "kiro"
    if "copilot" in transcript.lower():
        return "copilot"
    return "claude"


def normalize_run(run: dict) -> dict:
    ts = run.get("ts") or run.get("timestamp")
    if not ts:
        ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    run["ts"] = ts
    run["timestamp"] = ts

    if "agent" not in run:
        run["agent"] = infer_agent(run)

    if "session_id" not in run:
        run["session_id"] = f"unknown_{ts}"

    if "success" not in run and "rc" in run:
        run["success"] = run["rc"] == 0
    if "rc" not in run and "success" in run:
        run["rc"] = 0 if run["success"] else 1

    tokens = run.get("tokens") or 0
    if tokens and "cost" not in run:
        run["cost"] = round(token_cost_usd(int(tokens)), 6)

    return run


def backfill_runs(runs_file: Path, *, dry_run: bool = False) -> int:
    if not runs_file.exists():
        print(f"No runs file at {runs_file}")
        return 0

    backup = runs_file.with_suffix(".jsonl.bak")
    lines_in = runs_file.read_text(encoding="utf-8").splitlines()
    normalized: list[str] = []
    count = 0

    for line in lines_in:
        trimmed = line.strip()
        if not trimmed:
            continue
        try:
            run = normalize_run(json.loads(trimmed))
            normalized.append(json.dumps(run, ensure_ascii=False))
            count += 1
        except json.JSONDecodeError:
            normalized.append(trimmed)

    if dry_run:
        print(f"Would backfill {count} run(s) in {runs_file}")
        return count

    shutil.copy2(runs_file, backup)
    runs_file.write_text("\n".join(normalized) + ("\n" if normalized else ""), encoding="utf-8")
    print(f"Backfilled {count} run(s). Backup: {backup}")
    return count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=Path, default=Path.cwd())
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    runs_file = args.target.resolve() / ".claude" / "learning" / "runs.jsonl"
    backfill_runs(runs_file, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
