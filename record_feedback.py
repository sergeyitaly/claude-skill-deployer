#!/usr/bin/env python3
"""Append user negative-feedback records to .claude/learning/skill-feedback.jsonl."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FEEDBACK_RELATIVE = Path(".claude") / "learning" / "skill-feedback.jsonl"


def record_skill_feedback(
    skill_name: str,
    *,
    signal: str = "",
    user_text: str = "",
    context: str = "",
    sentiment: str = "negative",
    session_id: str | None = None,
    agent: str = "claude",
    target: str | Path | None = None,
) -> dict[str, Any]:
    """Append one feedback entry. Returns the written record."""
    root = Path(target or Path.cwd()).resolve()
    feedback_file = root / FEEDBACK_RELATIVE
    feedback_file.parent.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    entry: dict[str, Any] = {
        "ts": ts,
        "skill": skill_name,
        "sentiment": sentiment,
        "signal": signal[:120],
        "user_text": user_text[:300],
        "context": context[:500],
        "session_id": session_id or f"manual_{ts}",
        "agent": agent,
    }

    with feedback_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return entry


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Record negative user feedback for a skill")
    p.add_argument("skill", help="Skill name that received negative feedback")
    p.add_argument("--signal", default="", help="Trigger phrase detected (e.g. no, wrong)")
    p.add_argument("--user-text", default="", help="Truncated user message")
    p.add_argument("--context", default="", help="What the agent did that prompted feedback")
    p.add_argument("--sentiment", default="negative", choices=["negative", "correction", "disagreement"])
    p.add_argument("--session-id")
    p.add_argument("--agent", default="claude", choices=["claude", "cursor", "kiro", "copilot"])
    p.add_argument("--target", type=Path, default=Path.cwd())
    args = p.parse_args()
    rec = record_skill_feedback(
        args.skill,
        signal=args.signal,
        user_text=args.user_text,
        context=args.context,
        sentiment=args.sentiment,
        session_id=args.session_id,
        agent=args.agent,
        target=args.target,
    )
    print(json.dumps(rec))
