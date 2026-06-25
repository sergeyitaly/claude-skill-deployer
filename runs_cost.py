"""Per-skill cost aggregation from runs.jsonl (hook-grounded, model-aware)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from cost_utils import (
    ATTRIBUTION_COLLECTOR_SOURCE,
    SKILL_INVOKE_HOOK_SOURCE,
    UsageBreakdown,
    estimate_usage_cost_usd,
    read_pricing_overrides,
    token_cost_usd,
)

RUNS_RELATIVE = Path(".claude") / "learning" / "runs.jsonl"

CostMethod = Literal["usage_breakdown", "model_blended", "flat_blended", "stored"]


def is_collector_transcript_run(row: dict[str, Any]) -> bool:
    metadata = row.get("metadata") or {}
    return row.get("action") == "transcript" and metadata.get("source") == ATTRIBUTION_COLLECTOR_SOURCE


def is_usage_run_record(row: dict[str, Any]) -> bool:
    return not is_collector_transcript_run(row)


def is_v2_hook_run(row: dict[str, Any]) -> bool:
    metadata = row.get("metadata") or {}
    return metadata.get("source") == SKILL_INVOKE_HOOK_SOURCE and metadata.get("invoked") is True


def _parse_ts(row: dict[str, Any]) -> datetime | None:
    raw = row.get("ts") or row.get("timestamp")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _coerce_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _parse_usage_dict(usage: dict[str, Any]) -> UsageBreakdown | None:
    breakdown: UsageBreakdown = {
        "input_tokens": _coerce_int(usage.get("input_tokens")),
        "output_tokens": _coerce_int(usage.get("output_tokens")),
        "cache_creation_input_tokens": _coerce_int(
            usage.get("cache_creation_input_tokens") or usage.get("cacheCreationTokens")
        ),
        "cache_read_input_tokens": _coerce_int(
            usage.get("cache_read_input_tokens") or usage.get("cacheReadTokens")
        ),
    }
    return breakdown if sum(breakdown.values()) > 0 else None


def _build_usage_candidates(row: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    if isinstance(row.get("usage"), dict):
        candidates.append(row["usage"])
    metadata = row.get("metadata")
    if not isinstance(metadata, dict):
        return candidates
    for key in ("usage", "token_usage"):
        val = metadata.get(key)
        if isinstance(val, dict):
            candidates.append(val)
    flat = {
        "input_tokens": metadata.get("input_tokens"),
        "output_tokens": metadata.get("output_tokens"),
        "cache_creation_input_tokens": metadata.get("cache_creation_input_tokens"),
        "cache_read_input_tokens": metadata.get("cache_read_input_tokens"),
    }
    if any(flat.values()):
        candidates.append(flat)
    return candidates


def extract_usage_breakdown(row: dict[str, Any]) -> UsageBreakdown | None:
    """Pull input/output/cache counts from a runs.jsonl row or nested metadata."""
    for usage in _build_usage_candidates(row):
        result = _parse_usage_dict(usage)
        if result is not None:
            return result
    return None


def extract_model(row: dict[str, Any]) -> str | None:
    model = row.get("model")
    if isinstance(model, str) and model.strip():
        return model
    metadata = row.get("metadata")
    if isinstance(metadata, dict):
        meta_model = metadata.get("model")
        if isinstance(meta_model, str) and meta_model.strip():
            return meta_model
    return None


def total_tokens_from_usage(usage: UsageBreakdown) -> int:
    return sum(usage.values())


def find_transcript_for_session(session_id: str, roots: list[Path] | None = None) -> Path | None:
    if not session_id:
        return None
    search_roots = roots or [
        Path.home() / ".claude" / "projects",
        Path.home() / ".cursor" / "projects",
    ]
    name = f"{session_id}.jsonl"
    for root in search_roots:
        if not root.is_dir():
            continue
        for hit in root.rglob(name):
            if hit.is_file():
                return hit
    return None


def _resolve_transcript_path(
    metadata: dict[str, Any],
    session_id: str | None,
    transcript_roots: list[Path] | None,
) -> Path | None:
    file_hint = metadata.get("transcript_file") or metadata.get("file")
    if isinstance(file_hint, str):
        candidate = Path(file_hint)
        if candidate.is_file():
            return candidate
    if isinstance(session_id, str):
        return find_transcript_for_session(session_id, transcript_roots)
    return None


def compute_run_cost_with_transcript(
    row: dict[str, Any],
    *,
    overrides: dict | None = None,
    enrich_transcripts: bool = False,
    transcript_roots: list[Path] | None = None,
) -> tuple[float, CostMethod, int, str | None]:
    """Return (cost_usd, method, token_count, model_if_known)."""
    if enrich_transcripts and is_v2_hook_run(row) and not extract_usage_breakdown(row):
        metadata = row.get("metadata") or {}
        tool_use_id = metadata.get("tool_use_id")
        if isinstance(tool_use_id, str) and tool_use_id:
            transcript = _resolve_transcript_path(metadata, row.get("session_id"), transcript_roots)
            if transcript is not None:
                usage, model = lookup_tool_use_usage(transcript, tool_use_id)
                if usage:
                    tokens = total_tokens_from_usage(usage)
                    return (
                        estimate_usage_cost_usd(usage, model, overrides),
                        "usage_breakdown",
                        tokens,
                        model,
                    )
    cost, method, tokens = compute_run_cost(row, overrides=overrides)
    return cost, method, tokens, extract_model(row)


def compute_run_cost(
    row: dict[str, Any],
    *,
    overrides: dict | None = None,
    prefer_stored: bool = False,
) -> tuple[float, CostMethod, int]:
    """Return (cost_usd, method, token_count) for one runs.jsonl row."""
    usage = extract_usage_breakdown(row)
    model = extract_model(row)
    tokens = _coerce_int(row.get("tokens"))
    if usage:
        tokens = total_tokens_from_usage(usage)
        return estimate_usage_cost_usd(usage, model, overrides), "usage_breakdown", tokens

    stored = row.get("cost")
    if prefer_stored and isinstance(stored, (int, float)) and stored >= 0:
        return float(stored), "stored", tokens

    if model:
        return token_cost_usd(tokens, model, overrides), "model_blended", tokens

    if isinstance(stored, (int, float)) and stored >= 0:
        return float(stored), "stored", tokens

    return token_cost_usd(tokens, None, overrides), "flat_blended", tokens


@dataclass
class SkillCostRow:
    skill: str
    runs: int = 0
    hook_runs: int = 0
    tokens: int = 0
    stored_cost: float = 0.0
    computed_cost: float = 0.0
    methods: dict[str, int] = field(default_factory=dict)

    def add(self, *, tokens: int, stored: float, computed: float, method: CostMethod, hook: bool) -> None:
        self.runs += 1
        if hook:
            self.hook_runs += 1
        self.tokens += tokens
        self.stored_cost += stored
        self.computed_cost += computed
        self.methods[method] = self.methods.get(method, 0) + 1


@dataclass
class ModelCostRow:
    model: str
    runs: int = 0
    tokens: int = 0
    stored_cost: float = 0.0
    computed_cost: float = 0.0
    usage_breakdown_runs: int = 0


@dataclass
class RunsCostSummary:
    workspace: str
    runs_file: str
    period_days: int | None
    included_runs: int
    excluded_collector_runs: int
    duplicate_collector_runs: int
    total_tokens: int
    stored_cost_total: float
    computed_cost_total: float
    by_skill: list[SkillCostRow]
    by_model: list[ModelCostRow]
    hook_only: bool


def should_include_run(
    row: dict[str, Any],
    *,
    hook_only: bool,
    include_transcript: bool,
) -> bool:
    if is_collector_transcript_run(row):
        return include_transcript
    if not is_usage_run_record(row):
        return False
    if not hook_only:
        return True
    if is_v2_hook_run(row):
        return True
    metadata = row.get("metadata") or {}
    source = metadata.get("source")
    action = row.get("action")
    return source in ("self-learning", "extension") and action in ("run", "skill_invoke")


def _transcript_dedupe_key(row: dict[str, Any]) -> tuple[str, str, str] | None:
    if not is_collector_transcript_run(row):
        return None
    metadata = row.get("metadata") or {}
    skill = row.get("skill")
    session = row.get("session_id")
    file_path = metadata.get("file")
    if isinstance(skill, str) and isinstance(session, str) and isinstance(file_path, str):
        return skill, session, file_path
    return None


def load_runs_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _process_run_row(
    row: dict[str, Any],
    skill: str,
    *,
    overrides: dict | None,
    enrich_transcripts: bool,
    by_skill: dict[str, SkillCostRow],
    by_model: dict[str, ModelCostRow],
) -> tuple[int, float, float]:
    """Accumulate one valid run row into skill/model buckets. Returns (tokens, stored, computed)."""
    stored = float(row.get("cost") or 0)
    computed, method, tokens, model = compute_run_cost_with_transcript(
        row, overrides=overrides, enrich_transcripts=enrich_transcripts,
    )
    bucket = by_skill.setdefault(skill, SkillCostRow(skill=skill))
    bucket.add(tokens=tokens, stored=stored, computed=computed, method=method, hook=is_v2_hook_run(row))
    model_key = model or "unknown"
    mb = by_model.setdefault(model_key, ModelCostRow(model=model_key))
    mb.runs += 1
    mb.tokens += tokens
    mb.stored_cost += stored
    mb.computed_cost += computed
    if method == "usage_breakdown":
        mb.usage_breakdown_runs += 1
    return tokens, stored, computed


def _compute_cutoff(days: int | None) -> datetime | None:
    if days is not None and days > 0:
        return datetime.now(timezone.utc) - timedelta(days=days)
    return None


def _is_before_cutoff(row: dict[str, Any], cutoff: datetime | None) -> bool:
    """Return True when the row's timestamp precedes cutoff and the row should be excluded."""
    if cutoff is None:
        return False
    ts = _parse_ts(row)
    return ts is None or ts < cutoff


def _classify_run_row(
    row: dict[str, Any],
    *,
    hook_only: bool,
    include_transcript: bool,
) -> tuple[bool, bool]:
    """Return (should_process, is_excluded_collector).

    should_process=False  → skip this row.
    is_excluded_collector → the skip counts in excluded_collector_runs.
    """
    is_collector = is_collector_transcript_run(row)
    included = should_include_run(row, hook_only=hook_only, include_transcript=include_transcript)
    if not included:
        return False, is_collector
    return True, False


def _check_collector_dedup(
    row: dict[str, Any],
    *,
    include_transcript: bool,
    dedupe_collector: bool,
    seen_collector: set[tuple[str, str, str]],
) -> bool:
    """Return True if this collector row is a duplicate and should be skipped."""
    if not include_transcript or not is_collector_transcript_run(row):
        return False
    key = _transcript_dedupe_key(row)
    if key is None or not dedupe_collector:
        return False
    if key in seen_collector:
        return True
    seen_collector.add(key)
    return False


def summarize_skill_costs(
    target: Path | str,
    *,
    days: int | None = None,
    hook_only: bool = True,
    dedupe_collector: bool = True,
    include_transcript: bool = False,
    enrich_transcripts: bool = True,
) -> RunsCostSummary:
    workspace = Path(target).resolve()
    runs_file = workspace / RUNS_RELATIVE
    overrides = read_pricing_overrides(workspace)
    rows = load_runs_jsonl(runs_file)
    cutoff = _compute_cutoff(days)

    seen_collector: set[tuple[str, str, str]] = set()
    by_skill: dict[str, SkillCostRow] = {}
    by_model: dict[str, ModelCostRow] = {}
    included = 0
    excluded_collector = 0
    duplicate_collector = 0
    total_tokens = 0
    stored_total = 0.0
    computed_total = 0.0

    for row in rows:
        if _is_before_cutoff(row, cutoff):
            continue
        should_process, count_excluded = _classify_run_row(
            row, hook_only=hook_only, include_transcript=include_transcript,
        )
        if not should_process:
            if count_excluded:
                excluded_collector += 1
            continue
        if _check_collector_dedup(row, include_transcript=include_transcript,
                                   dedupe_collector=dedupe_collector, seen_collector=seen_collector):
            duplicate_collector += 1
            continue
        skill = str(row.get("skill") or "")
        if not skill:
            continue
        tokens, stored, computed = _process_run_row(
            row, skill, overrides=overrides, enrich_transcripts=enrich_transcripts,
            by_skill=by_skill, by_model=by_model,
        )
        included += 1
        total_tokens += tokens
        stored_total += stored
        computed_total += computed

    ranked = sorted(by_skill.values(), key=lambda s: s.computed_cost, reverse=True)
    ranked_models = sorted(by_model.values(), key=lambda m: m.computed_cost, reverse=True)
    return RunsCostSummary(
        workspace=str(workspace),
        runs_file=str(runs_file),
        period_days=days,
        included_runs=included,
        excluded_collector_runs=excluded_collector,
        duplicate_collector_runs=duplicate_collector,
        total_tokens=total_tokens,
        stored_cost_total=stored_total,
        computed_cost_total=computed_total,
        by_skill=ranked,
        by_model=ranked_models,
        hook_only=hook_only and not include_transcript,
    )


def _sum_usage(node: Any) -> tuple[UsageBreakdown | None, str | None]:
    if not isinstance(node, dict):
        return None, None
    usage_raw = None
    model = None
    message = node.get("message")
    if isinstance(message, dict):
        usage_raw = message.get("usage")
        model = message.get("model")
    if not usage_raw:
        usage_raw = node.get("usage")
    if not model and isinstance(node.get("model"), str):
        model = node["model"]
    if not isinstance(usage_raw, dict):
        return None, model if isinstance(model, str) else None
    usage: UsageBreakdown = {
        "input_tokens": _coerce_int(usage_raw.get("input_tokens")),
        "output_tokens": _coerce_int(usage_raw.get("output_tokens")),
        "cache_creation_input_tokens": _coerce_int(usage_raw.get("cache_creation_input_tokens")),
        "cache_read_input_tokens": _coerce_int(usage_raw.get("cache_read_input_tokens")),
    }
    if sum(usage.values()) <= 0:
        return None, model if isinstance(model, str) else None
    return usage, model if isinstance(model, str) else None


def _scan_follow_lines(
    lines: list[str], start: int
) -> tuple[UsageBreakdown | None, str | None]:
    for j in range(start + 1, min(start + 8, len(lines))):
        if "usage" not in lines[j]:
            continue
        try:
            follow = json.loads(lines[j])
        except json.JSONDecodeError:
            continue
        usage, model = _sum_usage(follow)
        if usage:
            return usage, model
    return None, None


def lookup_tool_use_usage(transcript_path: Path, tool_use_id: str) -> tuple[UsageBreakdown | None, str | None]:
    """Resolve usage + model for a tool_use_id from a session transcript JSONL."""
    if not transcript_path.is_file() or not tool_use_id:
        return None, None
    try:
        lines = transcript_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return None, None

    id_re = re.compile(rf'"id"\s*:\s*"{re.escape(tool_use_id)}"')
    for i, line in enumerate(lines):
        if "tool_use" not in line or not id_re.search(line):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        usage, model = _sum_usage(parsed)
        if usage:
            return usage, model
        usage, model = _scan_follow_lines(lines, i)
        if usage:
            return usage, model
    return None, None


def _try_enrich_row(row: dict[str, Any], *, overrides: dict | None) -> bool:
    """Enrich a single hook row from transcript usage. Returns True if enriched."""
    metadata = row.get("metadata") or {}
    tool_use_id = metadata.get("tool_use_id")
    transcript_file = metadata.get("transcript_file") or metadata.get("file")
    if not isinstance(tool_use_id, str) or not isinstance(transcript_file, str):
        return False
    usage, model = lookup_tool_use_usage(Path(transcript_file), tool_use_id)
    if not usage:
        return False
    row["tokens"] = total_tokens_from_usage(usage)
    if model:
        row["model"] = model
    row["cost"] = estimate_usage_cost_usd(usage, model, overrides)
    row["metadata"] = {**metadata, "usage": usage, "cost_method": "usage_breakdown",
                       "cost_enriched_from": "transcript"}
    return True


def enrich_hook_rows_from_transcripts(
    target: Path | str,
    *,
    days: int | None = None,
) -> int:
    """Recompute hook-row costs from transcript usage when tool_use_id + file are known."""
    workspace = Path(target).resolve()
    rows = load_runs_jsonl(workspace / RUNS_RELATIVE)
    overrides = read_pricing_overrides(workspace)
    cutoff: datetime | None = (
        datetime.now(timezone.utc) - timedelta(days=days)
        if days is not None and days > 0 else None
    )
    enriched = 0
    for row in rows:
        if not is_v2_hook_run(row):
            continue
        if cutoff is not None:
            ts = _parse_ts(row)
            if ts is None or ts < cutoff:
                continue
        if _try_enrich_row(row, overrides=overrides):
            enriched += 1
    return enriched
