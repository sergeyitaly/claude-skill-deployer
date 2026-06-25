"""Regression tests for runs_cost.py refactoring (v1.0.95).

Covers every extracted helper and verifies that summarize_skill_costs behaves
identically to the pre-refactor version across all significant branches.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from runs_cost import (
    RunsCostSummary,
    _build_usage_candidates,
    _check_collector_dedup,
    _classify_run_row,
    _compute_cutoff,
    _is_before_cutoff,
    _parse_usage_dict,
    _process_run_row,
    _resolve_transcript_path,
    _scan_follow_lines,
    _try_enrich_row,
    extract_usage_breakdown,
    load_runs_jsonl,
    lookup_tool_use_usage,
    ModelCostRow,
    SkillCostRow,
    summarize_skill_costs,
)


# ---------------------------------------------------------------------------
# _parse_usage_dict
# ---------------------------------------------------------------------------

class ParseUsageDictTests(unittest.TestCase):
    def test_happy_path(self):
        d = {"input_tokens": 100, "output_tokens": 50,
             "cache_creation_input_tokens": 10, "cache_read_input_tokens": 5}
        result = _parse_usage_dict(d)
        self.assertIsNotNone(result)
        self.assertEqual(result["input_tokens"], 100)
        self.assertEqual(result["output_tokens"], 50)

    def test_zero_sum_returns_none(self):
        self.assertIsNone(_parse_usage_dict({}))
        self.assertIsNone(_parse_usage_dict({"input_tokens": 0, "output_tokens": 0,
                                             "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}))

    def test_cache_creation_alias(self):
        d = {"cacheCreationTokens": 200, "cacheReadTokens": 50}
        result = _parse_usage_dict(d)
        self.assertIsNotNone(result)
        self.assertEqual(result["cache_creation_input_tokens"], 200)
        self.assertEqual(result["cache_read_input_tokens"], 50)

    def test_coerces_string_tokens(self):
        d = {"input_tokens": "1000", "output_tokens": "500",
             "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
        result = _parse_usage_dict(d)
        self.assertIsNotNone(result)
        self.assertEqual(result["input_tokens"], 1000)


# ---------------------------------------------------------------------------
# _build_usage_candidates
# ---------------------------------------------------------------------------

class BuildUsageCandidatesTests(unittest.TestCase):
    def test_top_level_usage(self):
        row = {"usage": {"input_tokens": 100, "output_tokens": 50,
                          "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
        candidates = _build_usage_candidates(row)
        self.assertIn(row["usage"], candidates)

    def test_metadata_usage_key(self):
        row = {"metadata": {"usage": {"input_tokens": 200, "output_tokens": 0,
                                       "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}
        candidates = _build_usage_candidates(row)
        self.assertEqual(len(candidates), 1)

    def test_metadata_token_usage_key(self):
        row = {"metadata": {"token_usage": {"input_tokens": 300, "output_tokens": 0,
                                             "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}
        candidates = _build_usage_candidates(row)
        self.assertEqual(len(candidates), 1)

    def test_flat_metadata_fields(self):
        row = {"metadata": {"input_tokens": 400, "output_tokens": 100,
                             "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
        candidates = _build_usage_candidates(row)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["input_tokens"], 400)

    def test_no_metadata_returns_empty(self):
        self.assertEqual(_build_usage_candidates({}), [])

    def test_non_dict_metadata_returns_empty(self):
        self.assertEqual(_build_usage_candidates({"metadata": "bad"}), [])

    def test_first_candidate_wins_in_extract(self):
        # top-level "usage" takes priority over metadata
        row = {
            "usage": {"input_tokens": 111, "output_tokens": 0,
                       "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            "metadata": {"usage": {"input_tokens": 999, "output_tokens": 0,
                                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}},
        }
        result = extract_usage_breakdown(row)
        self.assertIsNotNone(result)
        self.assertEqual(result["input_tokens"], 111)


# ---------------------------------------------------------------------------
# _resolve_transcript_path
# ---------------------------------------------------------------------------

class ResolveTranscriptPathTests(unittest.TestCase):
    def test_returns_none_when_no_hints(self):
        result = _resolve_transcript_path({}, None, None)
        self.assertIsNone(result)

    def test_returns_file_hint_when_exists(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
            p = Path(f.name)
        try:
            result = _resolve_transcript_path({"file": str(p)}, None, None)
            self.assertEqual(result, p)
        finally:
            p.unlink(missing_ok=True)

    def test_skips_nonexistent_file_hint_falls_to_session(self):
        # file_hint doesn't exist, session_id has no match in any search root → None
        result = _resolve_transcript_path({"file": "/nonexistent/path.jsonl"}, None, [])
        self.assertIsNone(result)

    def test_session_lookup_used_when_file_hint_missing(self):
        # Create a temp dir acting as a project root with a matching session file
        with tempfile.TemporaryDirectory() as tmp:
            session_id = "testsession-abc123"
            session_file = Path(tmp) / f"{session_id}.jsonl"
            session_file.write_text("{}\n", encoding="utf-8")
            result = _resolve_transcript_path({}, session_id, [Path(tmp)])
            self.assertEqual(result, session_file)


# ---------------------------------------------------------------------------
# _compute_cutoff / _is_before_cutoff
# ---------------------------------------------------------------------------

class CutoffTests(unittest.TestCase):
    def test_compute_cutoff_none_when_no_days(self):
        self.assertIsNone(_compute_cutoff(None))
        self.assertIsNone(_compute_cutoff(0))

    def test_compute_cutoff_returns_datetime(self):
        cutoff = _compute_cutoff(7)
        self.assertIsNotNone(cutoff)
        self.assertIsInstance(cutoff, datetime)
        expected = datetime.now(timezone.utc) - timedelta(days=7)
        self.assertAlmostEqual(cutoff.timestamp(), expected.timestamp(), delta=2)

    def test_is_before_cutoff_none_cutoff(self):
        row = {"ts": "2020-01-01T00:00:00Z"}
        self.assertFalse(_is_before_cutoff(row, None))

    def test_is_before_cutoff_old_row(self):
        cutoff = datetime.now(timezone.utc) - timedelta(days=1)
        row = {"ts": "2020-01-01T00:00:00Z"}
        self.assertTrue(_is_before_cutoff(row, cutoff))

    def test_is_before_cutoff_recent_row(self):
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        row = {"ts": datetime.now(timezone.utc).isoformat()}
        self.assertFalse(_is_before_cutoff(row, cutoff))

    def test_is_before_cutoff_missing_ts_is_excluded(self):
        cutoff = datetime.now(timezone.utc) - timedelta(days=1)
        self.assertTrue(_is_before_cutoff({}, cutoff))


# ---------------------------------------------------------------------------
# _classify_run_row
# ---------------------------------------------------------------------------

class ClassifyRunRowTests(unittest.TestCase):
    def _hook_row(self) -> dict:
        return {"action": "skill_invoke", "skill": "ci-preflight",
                "metadata": {"source": "skill-invoke-hook-v2", "invoked": True}}

    def _collector_row(self) -> dict:
        return {"action": "transcript", "skill": "ci-preflight",
                "metadata": {"source": "attribution-collector", "file": "/tmp/s.jsonl"}}

    def test_hook_row_included(self):
        should_process, count_excluded = _classify_run_row(
            self._hook_row(), hook_only=True, include_transcript=False
        )
        self.assertTrue(should_process)
        self.assertFalse(count_excluded)

    def test_collector_row_excluded_when_include_transcript_false(self):
        should_process, count_excluded = _classify_run_row(
            self._collector_row(), hook_only=True, include_transcript=False
        )
        self.assertFalse(should_process)
        self.assertTrue(count_excluded)   # must count toward excluded_collector_runs

    def test_collector_row_included_when_include_transcript_true(self):
        should_process, count_excluded = _classify_run_row(
            self._collector_row(), hook_only=True, include_transcript=True
        )
        self.assertTrue(should_process)
        self.assertFalse(count_excluded)

    def test_non_hook_row_excluded_silently_when_hook_only(self):
        row = {"action": "run", "skill": "ci-preflight",
               "metadata": {"source": "some-other-source"}}
        should_process, count_excluded = _classify_run_row(
            row, hook_only=True, include_transcript=False
        )
        self.assertFalse(should_process)
        self.assertFalse(count_excluded)   # NOT a collector row, so not counted


# ---------------------------------------------------------------------------
# _check_collector_dedup
# ---------------------------------------------------------------------------

class CheckCollectorDedupTests(unittest.TestCase):
    def _collector_row(self, skill="sk", session="sess", file="/t.jsonl") -> dict:
        return {"action": "transcript", "skill": skill, "session_id": session,
                "metadata": {"source": "attribution-collector", "file": file}}

    def test_non_collector_returns_false(self):
        seen: set = set()
        row = {"action": "skill_invoke", "metadata": {"source": "skill-invoke-hook-v2", "invoked": True}}
        self.assertFalse(_check_collector_dedup(row, include_transcript=True,
                                                dedupe_collector=True, seen_collector=seen))

    def test_first_occurrence_not_duplicate(self):
        seen: set = set()
        row = self._collector_row()
        result = _check_collector_dedup(row, include_transcript=True,
                                        dedupe_collector=True, seen_collector=seen)
        self.assertFalse(result)
        self.assertEqual(len(seen), 1)

    def test_second_occurrence_is_duplicate(self):
        seen: set = set()
        row = self._collector_row()
        _check_collector_dedup(row, include_transcript=True, dedupe_collector=True, seen_collector=seen)
        result = _check_collector_dedup(row, include_transcript=True,
                                        dedupe_collector=True, seen_collector=seen)
        self.assertTrue(result)

    def test_dedupe_disabled_never_duplicate(self):
        seen: set = set()
        row = self._collector_row()
        for _ in range(3):
            result = _check_collector_dedup(row, include_transcript=True,
                                            dedupe_collector=False, seen_collector=seen)
            self.assertFalse(result)
        self.assertEqual(len(seen), 0)

    def test_include_transcript_false_returns_false(self):
        seen: set = set()
        row = self._collector_row()
        self.assertFalse(_check_collector_dedup(row, include_transcript=False,
                                                dedupe_collector=True, seen_collector=seen))


# ---------------------------------------------------------------------------
# _process_run_row
# ---------------------------------------------------------------------------

class ProcessRunRowTests(unittest.TestCase):
    def test_accumulates_into_buckets(self):
        row = {"skill": "ci-preflight", "tokens": 500, "cost": 0.005,
               "metadata": {"source": "skill-invoke-hook-v2", "invoked": True}}
        by_skill: dict = {}
        by_model: dict = {}
        tokens, stored, computed = _process_run_row(
            row, "ci-preflight", overrides=None, enrich_transcripts=False,
            by_skill=by_skill, by_model=by_model,
        )
        self.assertEqual(tokens, 500)
        self.assertAlmostEqual(stored, 0.005)
        self.assertIn("ci-preflight", by_skill)
        self.assertEqual(by_skill["ci-preflight"].runs, 1)
        self.assertEqual(by_skill["ci-preflight"].hook_runs, 1)

    def test_unknown_model_fallback(self):
        row = {"skill": "pdf", "tokens": 100, "cost": 0.001}
        by_skill: dict = {}
        by_model: dict = {}
        _process_run_row(row, "pdf", overrides=None, enrich_transcripts=False,
                         by_skill=by_skill, by_model=by_model)
        self.assertIn("unknown", by_model)

    def test_usage_breakdown_method_counted(self):
        row = {
            "skill": "vitest-extension-testing",
            "metadata": {
                "source": "skill-invoke-hook-v2", "invoked": True,
                "usage": {"input_tokens": 1000, "output_tokens": 200,
                           "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            },
        }
        by_skill: dict = {}
        by_model: dict = {}
        _process_run_row(row, "vitest-extension-testing", overrides=None, enrich_transcripts=False,
                         by_skill=by_skill, by_model=by_model)
        self.assertEqual(by_model.get("unknown", by_model.get(list(by_model)[0])).usage_breakdown_runs, 1)


# ---------------------------------------------------------------------------
# _scan_follow_lines
# ---------------------------------------------------------------------------

class ScanFollowLinesTests(unittest.TestCase):
    def test_finds_usage_within_window(self):
        usage_data = {"usage": {"input_tokens": 100, "output_tokens": 50,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
        lines = [
            '{"type": "tool_use", "id": "toolu_1"}',
            '{"irrelevant": true}',
            json.dumps(usage_data),
        ]
        result_usage, _ = _scan_follow_lines(lines, 0)
        self.assertIsNotNone(result_usage)
        self.assertEqual(result_usage["input_tokens"], 100)

    def test_returns_none_when_no_usage_in_window(self):
        lines = ['{"type": "tool_use"}'] + ['{"x": 1}'] * 10
        result_usage, _ = _scan_follow_lines(lines, 0)
        self.assertIsNone(result_usage)

    def test_skips_malformed_json(self):
        lines = [
            '{"type": "tool_use"}',
            "not json",
            '{"usage": {"input_tokens": 50, "output_tokens": 0, '
            '"cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}',
        ]
        result_usage, _ = _scan_follow_lines(lines, 0)
        self.assertIsNotNone(result_usage)


# ---------------------------------------------------------------------------
# _try_enrich_row
# ---------------------------------------------------------------------------

class TryEnrichRowTests(unittest.TestCase):
    def test_returns_false_when_no_tool_use_id(self):
        row = {"metadata": {"source": "skill-invoke-hook-v2", "invoked": True}}
        self.assertFalse(_try_enrich_row(row, overrides=None))

    def test_returns_false_when_no_transcript_file(self):
        row = {"metadata": {"source": "skill-invoke-hook-v2", "invoked": True,
                             "tool_use_id": "toolu_abc"}}
        self.assertFalse(_try_enrich_row(row, overrides=None))

    def test_enriches_row_from_transcript(self):
        with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False, encoding="utf-8") as f:
            json.dump({
                "type": "tool_use", "id": "toolu_enrich",
                "message": {
                    "model": "claude-sonnet-4-6",
                    "usage": {"input_tokens": 200, "output_tokens": 100,
                               "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                },
            }, f)
            f.write("\n")
            transcript = Path(f.name)
        try:
            row: dict = {"metadata": {"source": "skill-invoke-hook-v2", "invoked": True,
                                       "tool_use_id": "toolu_enrich",
                                       "file": str(transcript)}}
            result = _try_enrich_row(row, overrides=None)
            self.assertTrue(result)
            self.assertEqual(row["tokens"], 300)
            self.assertEqual(row["metadata"]["cost_method"], "usage_breakdown")
            self.assertEqual(row["metadata"]["cost_enriched_from"], "transcript")
        finally:
            transcript.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# summarize_skill_costs — behavioral equivalence suite
# ---------------------------------------------------------------------------

def _write_runs(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def _hook_row(skill: str, ts: str, tokens: int = 500, cost: float = 0.005) -> dict:
    return {"ts": ts, "skill": skill, "action": "skill_invoke", "tokens": tokens, "cost": cost,
            "metadata": {"source": "skill-invoke-hook-v2", "invoked": True}}


def _collector_row(skill: str, ts: str, session: str, file: str = "/t.jsonl") -> dict:
    return {"ts": ts, "skill": skill, "action": "transcript", "session_id": session,
            "tokens": 3_000_000, "cost": 27.0,
            "metadata": {"source": "attribution-collector", "file": file}}


RECENT = datetime.now(timezone.utc).isoformat()
OLD = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()


class SummarizeSkillCostsRegressionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._ws = Path(self._tmp)
        self._runs = self._ws / ".claude" / "learning" / "runs.jsonl"

    def test_hook_rows_included_collector_excluded(self):
        _write_runs(self._runs, [
            _hook_row("ci-preflight", RECENT),
            _collector_row("ci-preflight", RECENT, "s1"),
        ])
        s = summarize_skill_costs(self._ws, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 1)
        self.assertEqual(s.excluded_collector_runs, 1)
        self.assertEqual(s.duplicate_collector_runs, 0)

    def test_cutoff_filters_old_rows(self):
        _write_runs(self._runs, [
            _hook_row("ci-preflight", RECENT),
            _hook_row("ci-preflight", OLD),
        ])
        s = summarize_skill_costs(self._ws, days=7, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 1)

    def test_duplicate_collector_rows_counted(self):
        _write_runs(self._runs, [
            _collector_row("ci-preflight", RECENT, "s1", "/f.jsonl"),
            _collector_row("ci-preflight", RECENT, "s1", "/f.jsonl"),  # same key
        ])
        s = summarize_skill_costs(self._ws, include_transcript=True, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 1)
        self.assertEqual(s.duplicate_collector_runs, 1)

    def test_dedup_disabled_includes_both_collector_rows(self):
        _write_runs(self._runs, [
            _collector_row("ci-preflight", RECENT, "s1", "/f.jsonl"),
            _collector_row("ci-preflight", RECENT, "s1", "/f.jsonl"),
        ])
        s = summarize_skill_costs(self._ws, include_transcript=True,
                                  dedupe_collector=False, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 2)
        self.assertEqual(s.duplicate_collector_runs, 0)

    def test_row_without_skill_skipped(self):
        _write_runs(self._runs, [
            {"ts": RECENT, "action": "skill_invoke", "tokens": 100, "cost": 0.001,
             "metadata": {"source": "skill-invoke-hook-v2", "invoked": True}},
        ])
        s = summarize_skill_costs(self._ws, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 0)

    def test_multiple_skills_ranked_by_cost(self):
        _write_runs(self._runs, [
            _hook_row("cheap-skill", RECENT, tokens=100, cost=0.001),
            _hook_row("expensive-skill", RECENT, tokens=5000, cost=0.05),
        ])
        s = summarize_skill_costs(self._ws, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 2)
        self.assertEqual(s.by_skill[0].skill, "expensive-skill")

    def test_hook_only_flag_excludes_legacy_source(self):
        _write_runs(self._runs, [
            {"ts": RECENT, "skill": "ci-preflight", "action": "run", "tokens": 200, "cost": 0.002,
             "metadata": {"source": "some-unknown-source"}},
        ])
        s = summarize_skill_costs(self._ws, hook_only=True, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 0)

    def test_hook_only_false_includes_all_non_collector(self):
        _write_runs(self._runs, [
            {"ts": RECENT, "skill": "ci-preflight", "action": "run", "tokens": 200, "cost": 0.002,
             "metadata": {"source": "some-unknown-source"}},
        ])
        s = summarize_skill_costs(self._ws, hook_only=False, enrich_transcripts=False)
        self.assertEqual(s.included_runs, 1)

    def test_period_days_returned_in_summary(self):
        _write_runs(self._runs, [_hook_row("ci-preflight", RECENT)])
        s = summarize_skill_costs(self._ws, days=30, enrich_transcripts=False)
        self.assertEqual(s.period_days, 30)

    def test_totals_accumulate_correctly(self):
        _write_runs(self._runs, [
            _hook_row("sk-a", RECENT, tokens=1000, cost=0.01),
            _hook_row("sk-b", RECENT, tokens=2000, cost=0.02),
        ])
        s = summarize_skill_costs(self._ws, enrich_transcripts=False)
        self.assertEqual(s.total_tokens, 3000)
        self.assertAlmostEqual(s.stored_cost_total, 0.03, places=4)


if __name__ == "__main__":
    unittest.main()
