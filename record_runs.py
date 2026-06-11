#!/usr/bin/env python3
"""Append structured skill run records to .claude/learning/runs.jsonl."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cost_utils import BLENDED_USD_PER_M_TOKEN

RUNS_RELATIVE = Path(".claude") / "learning" / "runs.jsonl"


def _git_branch(cwd: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=True,
        )
        branch = out.stdout.strip()
        return branch if branch != "HEAD" else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def token_cost_usd(tokens: int) -> float:
    return (tokens / 1_000_000) * BLENDED_USD_PER_M_TOKEN


def record_skill_run(
    skill_name: str,
    agent: str,
    tokens: int,
    success: bool,
    *,
    action: str = "run",
    session_id: str | None = None,
    project: str | Path | None = None,
    branch: str | None = None,
    metadata: dict[str, Any] | None = None,
    target: str | Path | None = None,
) -> dict[str, Any]:
    """Append one run entry. Returns the written record."""
    root = Path(target or project or Path.cwd()).resolve()
    runs_file = root / RUNS_RELATIVE
    runs_file.parent.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    entry: dict[str, Any] = {
        "ts": ts,
        "timestamp": ts,
        "skill": skill_name,
        "action": action,
        "agent": agent,
        "tokens": tokens,
        "cost": round(token_cost_usd(tokens), 6),
        "rc": 0 if success else 1,
        "success": success,
        "session_id": session_id or f"manual_{ts}",
        "project": str(root),
        "branch": branch if branch is not None else _git_branch(root),
        "metadata": metadata or {},
    }

    with runs_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return entry


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Record a skill run in runs.jsonl")
    p.add_argument("skill")
    p.add_argument("--agent", default="claude", choices=["claude", "cursor", "kiro", "copilot"])
    p.add_argument("--tokens", type=int, required=True)
    p.add_argument("--success", action="store_true", default=True)
    p.add_argument("--fail", action="store_true")
    p.add_argument("--action", default="run")
    p.add_argument("--session-id")
    p.add_argument("--target", type=Path, default=Path.cwd())
    args = p.parse_args()
    rec = record_skill_run(
        args.skill,
        args.agent,
        args.tokens,
        success=not args.fail,
        action=args.action,
        session_id=args.session_id,
        target=args.target,
    )
    print(json.dumps(rec))
