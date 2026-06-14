"""Tests for runs_cost.py and model-aware pricing."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from cost_utils import estimate_usage_cost_usd, pricing_for_model, token_cost_usd
from runs_cost import (
    compute_run_cost,
    compute_run_cost_with_transcript,
    is_collector_transcript_run,
    is_usage_run_record,
    is_v2_hook_run,
    should_include_run,
    summarize_skill_costs,
)


class SkillCostFromRunsTests(unittest.TestCase):
    def test_pricing_for_model_fable(self):
        pricing = pricing_for_model("claude-fable-5")
        self.assertEqual(pricing.input, 10)
        self.assertEqual(pricing.output, 50)

    def test_pricing_for_model_opus(self):
        pricing = pricing_for_model("claude-opus-4-6")
        self.assertEqual(pricing.input, 5)
        self.assertEqual(pricing.output, 25)

    def test_estimate_usage_cost_sonnet(self):
        cost = estimate_usage_cost_usd(
            {
                "input_tokens": 1_000_000,
                "output_tokens": 0,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
            "claude-sonnet-4-6",
        )
        self.assertAlmostEqual(cost, 3.0)

    def test_token_cost_blended_sonnet(self):
        self.assertAlmostEqual(token_cost_usd(1_000_000, "claude-sonnet-4-6"), 9.0)

    def test_collector_run_detection(self):
        row = {
            "action": "transcript",
            "metadata": {"source": "attribution-collector"},
        }
        self.assertTrue(is_collector_transcript_run(row))
        self.assertFalse(is_usage_run_record(row))

    def test_v2_hook_run_detection(self):
        row = {
            "metadata": {"source": "skill-invoke-hook-v2", "invoked": True},
        }
        self.assertTrue(is_v2_hook_run(row))

    def test_compute_run_cost_usage_breakdown(self):
        row = {
            "tokens": 999,
            "cost": 0.01,
            "model": "claude-sonnet-4-6",
            "metadata": {
                "usage": {
                    "input_tokens": 10_000,
                    "output_tokens": 1_000,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 5_000,
                }
            },
        }
        cost, method, tokens = compute_run_cost(row)
        self.assertEqual(method, "usage_breakdown")
        self.assertEqual(tokens, 16_000)
        self.assertAlmostEqual(
            cost,
            (10_000 / 1e6) * 3 + (1_000 / 1e6) * 15 + (5_000 / 1e6) * 0.3,
        )

    def test_should_include_hook_only(self):
        hook = {
            "skill": "ci-preflight",
            "action": "skill_invoke",
            "metadata": {"source": "skill-invoke-hook-v2", "invoked": True},
        }
        collector = {
            "skill": "ci-preflight",
            "action": "transcript",
            "metadata": {"source": "attribution-collector"},
        }
        self.assertTrue(should_include_run(hook, hook_only=True, include_transcript=False))
        self.assertFalse(should_include_run(collector, hook_only=True, include_transcript=False))

    def test_summarize_excludes_collector_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            learning = tmp_path / ".claude" / "learning"
            learning.mkdir(parents=True)
            runs = learning / "runs.jsonl"
            rows = [
                {
                    "ts": "2026-06-14T12:00:00Z",
                    "skill": "profile-init",
                    "action": "skill_invoke",
                    "tokens": 1000,
                    "cost": 0.009,
                    "metadata": {"source": "skill-invoke-hook-v2", "invoked": True},
                },
                {
                    "ts": "2026-06-14T12:00:00Z",
                    "skill": "profile-init",
                    "action": "transcript",
                    "tokens": 3_000_000,
                    "cost": 27.0,
                    "metadata": {"source": "attribution-collector", "file": "/tmp/s.jsonl"},
                },
            ]
            runs.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

            summary = summarize_skill_costs(tmp_path, enrich_transcripts=False)
            self.assertEqual(summary.included_runs, 1)
            self.assertEqual(summary.excluded_collector_runs, 1)
            self.assertEqual(summary.total_tokens, 1000)
            self.assertAlmostEqual(summary.computed_cost_total, 0.009)
            self.assertEqual(len(summary.by_skill), 1)
            self.assertEqual(summary.by_skill[0].skill, "profile-init")

    def test_enrich_transcripts_uses_usage_breakdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            transcript = tmp_path / "session.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "tool_use",
                        "id": "toolu_test123",
                        "message": {
                            "model": "claude-sonnet-4-6",
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 50,
                                "cache_creation_input_tokens": 0,
                                "cache_read_input_tokens": 200,
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            row = {
                "tokens": 5000,
                "cost": 0.045,
                "session_id": "sess-1",
                "metadata": {
                    "source": "skill-invoke-hook-v2",
                    "invoked": True,
                    "tool_use_id": "toolu_test123",
                    "file": str(transcript),
                },
            }

            cost, method, tokens, model = compute_run_cost_with_transcript(row, enrich_transcripts=True)
            self.assertEqual(method, "usage_breakdown")
            self.assertEqual(tokens, 350)
            self.assertEqual(model, "claude-sonnet-4-6")
            self.assertAlmostEqual(cost, (100 / 1e6) * 3 + (50 / 1e6) * 15 + (200 / 1e6) * 0.3)


if __name__ == "__main__":
    unittest.main()
