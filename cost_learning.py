#!/usr/bin/env python3
"""Cost prediction accuracy tracking for the self-learning skill."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

COST_LEARNING_PATH = Path(".claude") / "learning" / "cost-learning.jsonl"
COST_MODEL_PATH = Path.home() / ".claude" / "learning" / "cost-models.json"


def record_cost_outcome(
    skill_name: str,
    expected_cost: float,
    actual_cost: float,
    success: bool,
    *,
    target: Path | None = None,
) -> dict:
    """Append one cost accuracy record and update per-skill adjustment factor."""
    root = (target or Path.cwd()).resolve()
    out_file = root / COST_LEARNING_PATH
    out_file.parent.mkdir(parents=True, exist_ok=True)

    accuracy = actual_cost / expected_cost if expected_cost else None
    row = {
        "skill": skill_name,
        "expected_cost": expected_cost,
        "actual_cost": actual_cost,
        "accuracy": accuracy,
        "success": success,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    with out_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")

    update_cost_model(skill_name, accuracy)
    return row


def update_cost_model(skill_name: str, accuracy: float | None) -> None:
    """Adjust future cost multiplier from historical prediction accuracy."""
    if accuracy is None or accuracy <= 0:
        return
    models: dict = {}
    if COST_MODEL_PATH.exists():
        try:
            models = json.loads(COST_MODEL_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            models = {}

    prev = models.get(skill_name, {"multiplier": 1.0, "samples": 0})
    samples = int(prev.get("samples", 0)) + 1
    multiplier = float(prev.get("multiplier", 1.0))
    multiplier = multiplier * 0.8 + accuracy * 0.2
    models[skill_name] = {
        "multiplier": round(multiplier, 4),
        "samples": samples,
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    COST_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    COST_MODEL_PATH.write_text(json.dumps(models, indent=2) + "\n", encoding="utf-8")


def adjusted_cost_estimate(skill_name: str, base_cost: float) -> float:
    if not COST_MODEL_PATH.exists():
        return base_cost
    try:
        models = json.loads(COST_MODEL_PATH.read_text(encoding="utf-8"))
        mult = float(models.get(skill_name, {}).get("multiplier", 1.0))
        return base_cost * mult
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return base_cost
