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
LEGACY_COST_ATTRIBUTION = Path.home() / ".claude/learning/cost-attribution.json"
COLLECTOR_STATE = Path.home() / ".claude/learning/attribution-collector-state.json"


def cost_attribution_path(target: Path) -> Path:
    return target / ".claude" / "learning" / "cost-attribution.json"


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
    attr_path = cost_attribution_path(target)
    if not attr_path.is_file() and LEGACY_COST_ATTRIBUTION.is_file():
        try:
            legacy = json.loads(LEGACY_COST_ATTRIBUTION.read_text(encoding="utf-8"))
            legacy_ws = legacy.get("workspacePath")
            if not legacy_ws or Path(legacy_ws).resolve() == target.resolve():
                attr_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(LEGACY_COST_ATTRIBUTION, attr_path)
        except (json.JSONDecodeError, OSError):
            pass

    if attr_path.is_file():
        backup_attr = attr_path.with_suffix(f".json.pre-reset-{int(time.time())}.bak")
        shutil.copy2(attr_path, backup_attr)
        try:
            raw = json.loads(attr_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            raw = {}
        raw["transcriptSkills"] = {}
        raw["unattributed"] = {}
        raw.pop("skills", None)
        raw["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        attr_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")

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
