#!/usr/bin/env python3
"""Tests for skills_sync.py headless apply/sync layer."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from skills_sync import (  # noqa: E402
    apply_local_profile,
    apply_proposed_skills,
    process_session_apply,
    read_skill_overrides,
    set_skill_override,
    sync_branch_profile,
)


def _init_git(path: Path, branch: str = "main") -> None:
    subprocess.run(["git", "init", "-b", branch], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True, capture_output=True)
    (path / "README.md").write_text("# test\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=path, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=path, check=True, capture_output=True)


class SkillsSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="skills-sync-")
        self.target = Path(self.tmp) / "workspace"
        self.target.mkdir(parents=True)
        self.library = REPO_ROOT / "skills_library"
        self.global_backup = Path.home() / ".claude" / "skills"
        _init_git(self.target)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_global_skill(self, name: str) -> None:
        src = self.library / name
        if not (src / "SKILL.md").is_file():
            self.skipTest(f"skill {name} missing in library")
        dest = self.global_backup / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)

    def test_apply_session_installs_and_clears_override(self) -> None:
        self._seed_global_skill("self-learning")
        set_skill_override(self.target, "self-learning", "off")
        learning = self.target / ".claude" / "learning"
        learning.mkdir(parents=True)
        (learning / "session-skill-apply-request.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "requestedAt": "2026-06-13T00:00:00Z",
                    "sessionId": "sess-1",
                    "platform": "claude",
                    "skills": ["self-learning"],
                    "source": "profile",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        out = process_session_apply(self.library, self.target)
        self.assertTrue(out["applied"])
        self.assertTrue((self.target / ".claude" / "skills" / "self-learning" / "SKILL.md").is_file())
        self.assertNotEqual(read_skill_overrides(self.target).get("self-learning"), "off")

    def test_apply_session_dedupes_by_session_id(self) -> None:
        self._seed_global_skill("file-style-conventions")
        learning = self.target / ".claude" / "learning"
        learning.mkdir(parents=True)
        (learning / "session-skill-apply-request.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "requestedAt": "2026-06-13T00:00:00Z",
                    "sessionId": "sess-dup",
                    "skills": ["file-style-conventions"],
                    "source": "proposals",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        first = process_session_apply(self.library, self.target)
        second = process_session_apply(self.library, self.target)
        self.assertTrue(first["applied"])
        self.assertFalse(second["applied"])

    def test_apply_profile_marks_applied(self) -> None:
        self._seed_global_skill("self-learning")
        catalog = {
            "version": 1,
            "generatedAt": "2026-06-13T00:00:00Z",
            "workspacePath": str(self.target),
            "skills": [{"name": "self-learning"}],
        }
        learning = self.target / ".claude" / "learning"
        learning.mkdir(parents=True)
        (learning / "skills-catalog.json").write_text(json.dumps(catalog) + "\n", encoding="utf-8")
        profile_path = self.target / ".claude" / "profile.local.json"
        profile_path.parent.mkdir(parents=True, exist_ok=True)
        profile_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "branch": "main",
                    "skills": ["self-learning"],
                    "status": "pending",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        out = apply_local_profile(self.library, self.target)
        self.assertTrue(out["applied"])
        applied = json.loads(profile_path.read_text(encoding="utf-8"))
        self.assertEqual(applied["status"], "applied")

    def test_sync_branch_applies_saved_profile(self) -> None:
        self._seed_global_skill("self-learning")
        apply_proposed_skills(self.library, self.target, ["self-learning"])
        out = sync_branch_profile(self.library, self.target)
        self.assertIn("applied", out)


if __name__ == "__main__":
    unittest.main()
