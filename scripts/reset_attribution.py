#!/usr/bin/env python3
"""Remove mis-attributed collector rows and reset transcriptSkills for re-collection."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from pathlib import Path

RUNS_RELATIVE = Path(".claude/learning/runs.jsonl")
COST_ATTRIBUTION = Path.home() / ".claude/learning/cost-attribution.json"
COLLECTOR_STATE = Path.home() / ".claude/learning/attribution-collector-state.json"


def is_collector_transcript_run(line: str) -> bool:
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        return False
    return row.get("action") == "transcript" and (row.get("metadata") or {}).get("source") == "attribution-collector"


def reset_workspace(target: Path) -> dict:
    removed = kept = 0
    runs_file = target / RUNS_RELATIVE
    backup_runs = None

    if runs_file.is_file():
        backup_runs = runs_file.with_suffix(f".jsonl.pre-reset-{int(time.time())}.bak")
        shutil.copy2(runs_file, backup_runs)
        kept_lines: list[str] = []
        for line in runs_file.read_text(encoding="utf-8").splitlines():
            trimmed = line.strip()
            if not trimmed:
                continue
            if is_collector_transcript_run(trimmed):
                removed += 1
            else:
                kept_lines.append(trimmed)
                kept += 1
        runs_file.write_text("\n".join(kept_lines) + ("\n" if kept_lines else ""), encoding="utf-8")

    backup_attr = None
    if COST_ATTRIBUTION.is_file():
        backup_attr = COST_ATTRIBUTION.with_suffix(f".json.pre-reset-{int(time.time())}.bak")
        shutil.copy2(COST_ATTRIBUTION, backup_attr)
        try:
            raw = json.loads(COST_ATTRIBUTION.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raw = {}
        raw["transcriptSkills"] = {}
        raw["unattributed"] = {}
        raw.pop("skills", None)
        raw["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        COST_ATTRIBUTION.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")

    if COLLECTOR_STATE.is_file():
        backup_state = COLLECTOR_STATE.with_suffix(f".json.pre-reset-{int(time.time())}.bak")
        shutil.copy2(COLLECTOR_STATE, backup_state)
        COLLECTOR_STATE.write_text(
            json.dumps({"lastRun": 0, "fileMtimes": {}, "processedSessions": {}}, indent=2) + "\n",
            encoding="utf-8",
        )

    return {
        "removedRuns": removed,
        "keptRuns": kept,
        "backupRuns": str(backup_runs) if backup_runs else None,
        "backupAttribution": str(backup_attr) if backup_attr else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", nargs="?", default=os.getcwd(), help="Workspace root")
    args = parser.parse_args()
    result = reset_workspace(Path(args.workspace).resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
