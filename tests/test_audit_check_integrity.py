#!/usr/bin/env python3
"""Tests for the Workspace Intelligence audit checks (CHECK 7-11) in
scripts/audit_check_integrity.py."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from scripts.audit_check_integrity import IntegrityChecker  # noqa: E402


class AuditCheckIntegrityWorkspaceIntelligenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="audit-check-"))
        self.checker = IntegrityChecker()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, name: str, data) -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    # CHECK 7 ---------------------------------------------------------------

    def test_workspace_affinity_integrity_passes_valid_file(self) -> None:
        path = self._write("workspace-affinity.json", {
            "version": 1,
            "computedAt": "2026-01-01T00:00:00Z",
            "skills": {
                "k3s-kuberocketci": {
                    "skill": "k3s-kuberocketci", "observations": 265, "manualInvocations": 12,
                    "recommendationInvocations": 2, "successCount": 200, "reuseCount": 30,
                    "affinityScore": 95,
                }
            },
        })
        self.assertEqual(self.checker.check_workspace_affinity_integrity(str(path)), [])

    def test_workspace_affinity_integrity_flags_out_of_range_score(self) -> None:
        path = self._write("workspace-affinity.json", {
            "version": 1,
            "skills": {
                "bad-skill": {
                    "skill": "bad-skill", "observations": 1, "manualInvocations": 1,
                    "recommendationInvocations": 0, "successCount": 1, "reuseCount": 0,
                    "affinityScore": 150,
                }
            },
        })
        issues = self.checker.check_workspace_affinity_integrity(str(path))
        self.assertTrue(any("affinityScore" in i for i in issues))

    def test_workspace_affinity_integrity_flags_missing_fields(self) -> None:
        path = self._write("workspace-affinity.json", {
            "version": 1,
            "skills": {"incomplete-skill": {"skill": "incomplete-skill", "affinityScore": 50}},
        })
        issues = self.checker.check_workspace_affinity_integrity(str(path))
        self.assertTrue(any("missing field" in i for i in issues))

    def test_workspace_affinity_integrity_recovers_from_corrupt_file(self) -> None:
        path = self.tmp / "workspace-affinity.json"
        path.write_text("{not valid json", encoding="utf-8")
        issues = self.checker.check_workspace_affinity_integrity(str(path))
        self.assertEqual(len(issues), 1)
        self.assertIn("Cannot parse", issues[0])

    def test_workspace_affinity_integrity_ignores_missing_file(self) -> None:
        self.assertEqual(
            self.checker.check_workspace_affinity_integrity(str(self.tmp / "missing.json")), []
        )

    # CHECK 8 ---------------------------------------------------------------

    def test_recommendation_boost_validation_passes_valid_tier(self) -> None:
        path = self._write("task-skill-proposals.json", {
            "version": 1,
            "proposals": [{
                "name": "k3s-kuberocketci", "confidence": 93,
                "confidenceBreakdown": {
                    "semanticMatch": 42, "workspaceAffinity": 25, "repositoryAffinity": 15,
                    "adoptionSuccess": 11, "enrichment": 0, "penalty": 0,
                },
            }],
        })
        self.assertEqual(self.checker.check_recommendation_boost_validation(str(path)), [])

    def test_recommendation_boost_validation_flags_invalid_tier(self) -> None:
        path = self._write("task-skill-proposals.json", {
            "version": 1,
            "proposals": [{
                "name": "bad-boost", "confidence": 80,
                "confidenceBreakdown": {"workspaceAffinity": 17},
            }],
        })
        issues = self.checker.check_recommendation_boost_validation(str(path))
        self.assertTrue(any("workspaceAffinity boost" in i for i in issues))

    def test_recommendation_boost_validation_flags_out_of_range_confidence(self) -> None:
        path = self._write("task-skill-proposals.json", {
            "version": 1,
            "proposals": [{
                "name": "over-confident", "confidence": 140,
                "confidenceBreakdown": {"workspaceAffinity": 0},
            }],
        })
        issues = self.checker.check_recommendation_boost_validation(str(path))
        self.assertTrue(any("out of range" in i for i in issues))

    # CHECK 9 -----------------------------------------------------------------

    def test_manual_invocation_learning_passes_known_sources(self) -> None:
        path = self.tmp / "skill-adoption.jsonl"
        lines = [
            json.dumps({"event": "invoked", "source": "manual", "skill": "x"}),
            json.dumps({"event": "invoked", "source": "recommended", "skill": "y"}),
            json.dumps({"event": "proposed", "source": "auto", "skill": "z"}),
        ]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertEqual(self.checker.check_manual_invocation_learning(str(path)), [])

    def test_manual_invocation_learning_flags_unknown_source(self) -> None:
        path = self.tmp / "skill-adoption.jsonl"
        path.write_text(json.dumps({"event": "invoked", "source": "mystery", "skill": "x"}) + "\n", encoding="utf-8")
        issues = self.checker.check_manual_invocation_learning(str(path))
        self.assertTrue(any("unknown invocationSource" in i for i in issues))

    def test_manual_invocation_learning_skips_malformed_lines(self) -> None:
        path = self.tmp / "skill-adoption.jsonl"
        path.write_text("not json\n" + json.dumps({"event": "invoked", "source": "manual", "skill": "x"}) + "\n", encoding="utf-8")
        self.assertEqual(self.checker.check_manual_invocation_learning(str(path)), [])

    # CHECK 10 ----------------------------------------------------------------

    def test_skill_lifecycle_integrity_passes_valid_file(self) -> None:
        path = self._write("skill-lifecycle.json", {
            "version": 1,
            "skills": {
                "profile-init": {
                    "skill": "profile-init", "installedVersion": "1.0.0", "latestVersion": "1.1.0",
                    "status": "outdated", "affinity": 95, "usageLast30d": 120, "daysOutdated": 10,
                    "updatePriority": "HIGH", "priorityScore": 90,
                }
            },
        })
        self.assertEqual(self.checker.check_skill_lifecycle_integrity(str(path)), [])

    def test_skill_lifecycle_integrity_flags_invalid_status_and_priority(self) -> None:
        path = self._write("skill-lifecycle.json", {
            "version": 1,
            "skills": {
                "bad-record": {
                    "status": "unknown-status", "updatePriority": "URGENT", "affinity": 50,
                }
            },
        })
        issues = self.checker.check_skill_lifecycle_integrity(str(path))
        self.assertTrue(any("invalid status" in i for i in issues))
        self.assertTrue(any("invalid updatePriority" in i for i in issues))

    # CHECK 11 ----------------------------------------------------------------

    def test_outdated_skill_prioritization_passes_consistent_priority(self) -> None:
        path = self._write("skill-lifecycle.json", {
            "version": 1,
            "skills": {
                "profile-init": {"status": "outdated", "priorityScore": 90, "updatePriority": "HIGH"},
                "github-actions-ci": {"status": "outdated", "priorityScore": 56, "updatePriority": "MEDIUM"},
                "azure-infra-preflight": {"status": "outdated", "priorityScore": 5, "updatePriority": "LOW"},
                "current-skill": {"status": "current", "priorityScore": 5, "updatePriority": "LOW"},
            },
        })
        self.assertEqual(self.checker.check_outdated_skill_prioritization(str(path)), [])

    def test_outdated_skill_prioritization_flags_mismatched_bucket(self) -> None:
        path = self._write("skill-lifecycle.json", {
            "version": 1,
            "skills": {
                "mismatched": {"status": "outdated", "priorityScore": 90, "updatePriority": "LOW"},
            },
        })
        issues = self.checker.check_outdated_skill_prioritization(str(path))
        self.assertTrue(any("inconsistent with priorityScore" in i for i in issues))

    def test_outdated_skill_prioritization_flags_missing_score(self) -> None:
        path = self._write("skill-lifecycle.json", {
            "version": 1,
            "skills": {"no-score": {"status": "deprecated", "updatePriority": "LOW"}},
        })
        issues = self.checker.check_outdated_skill_prioritization(str(path))
        self.assertTrue(any("missing priorityScore" in i for i in issues))

    # Aggregation -------------------------------------------------------------

    def test_run_all_checks_includes_all_five_new_checks(self) -> None:
        skills_dir = self.tmp / "skills"
        skills_dir.mkdir()
        results = self.checker.run_all_checks(str(self.tmp), str(skills_dir))
        for key in (
            "workspace_affinity_integrity",
            "recommendation_boost_validation",
            "manual_invocation_learning",
            "skill_lifecycle_integrity",
            "outdated_skill_prioritization",
        ):
            self.assertIn(key, results["checks"])


if __name__ == "__main__":
    unittest.main()
