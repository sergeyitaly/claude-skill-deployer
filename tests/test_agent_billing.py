"""Tests for agent_billing.py (mocked HTTP, no live API keys)."""

from __future__ import annotations

import json
import sys
import unittest
from unittest.mock import patch

ROOT = __file__.replace("\\", "/").rsplit("/", 2)[0]
sys.path.insert(0, ROOT)

from agent_billing import (  # noqa: E402
    _amount_to_usd,
    fetch_claude_billing,
    fetch_copilot_billing,
    fetch_kiro_billing,
)


class AgentBillingTests(unittest.TestCase):
    def test_amount_to_usd_cents(self):
        self.assertAlmostEqual(_amount_to_usd("123.45"), 1.2345)

    @patch.dict("os.environ", {"ANTHROPIC_ADMIN_API_KEY": ""}, clear=False)
    def test_claude_skipped_without_key(self):
        row = fetch_claude_billing(7)
        self.assertEqual(row.agent, "claude")
        self.assertEqual(row.status, "skipped")

    @patch("agent_billing._http_json")
    @patch.dict("os.environ", {"ANTHROPIC_ADMIN_API_KEY": "sk-ant-admin01-test"}, clear=False)
    def test_claude_parses_cost_report(self, mock_http):
        def side_effect(url, **kwargs):
            if url.endswith("/cost_report"):
                return {
                    "data": [
                        {
                            "starting_at": "2026-06-01T00:00:00Z",
                            "results": [
                                {"amount": "150.00", "model": "claude-sonnet-4-6"},
                                {"amount": "50.00", "model": "claude-opus-4-8"},
                            ],
                        }
                    ]
                }
            return {
                "data": [
                    {
                        "results": [
                            {"model": "claude-sonnet-4-6", "uncached_input_tokens": 1000, "output_tokens": 200},
                        ]
                    }
                ]
            }

        mock_http.side_effect = side_effect
        row = fetch_claude_billing(7)
        self.assertEqual(row.status, "ok")
        self.assertEqual(row.kind, "invoice_usd")
        self.assertAlmostEqual(row.cost_usd or 0, 2.0)
        self.assertEqual(len(row.models), 2)

    def test_kiro_unavailable(self):
        row = fetch_kiro_billing()
        self.assertEqual(row.status, "skipped")
        self.assertEqual(row.kind, "unavailable")

    @patch("agent_billing._http_json")
    @patch.dict(
        "os.environ",
        {"GITHUB_TOKEN": "ghp_test", "GITHUB_ORG": "acme", "COPILOT_SEAT_PRICE_USD": "19"},
        clear=False,
    )
    def test_copilot_seat_billing(self, mock_http):
        def side_effect(url, **kwargs):
            if url.endswith("/copilot/billing"):
                return {"plan_type": "business", "seat_breakdown": {"total": 5}}
            return {"total_seats": 5, "seats": []}

        mock_http.side_effect = side_effect
        row = fetch_copilot_billing(30)
        self.assertEqual(row.status, "ok")
        self.assertEqual(row.kind, "subscription_seats")
        self.assertAlmostEqual(row.cost_usd or 0, 95.0)


if __name__ == "__main__":
    unittest.main()
