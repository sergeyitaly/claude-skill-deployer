#!/usr/bin/env python3
"""generate_skills.py -- detect a project's stack and install matching
Claude Code skills from a personal global skill library.

Usage:
  python generate_skills.py install [--force] [--dry-run]
  python generate_skills.py generate [--target PATH] [--all] [--force] [--dry-run]
  python generate_skills.py list [--target PATH]
  python generate_skills.py setup-task [--target PATH] [--force]
"""

import argparse
import fnmatch
import json
import os
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
LIBRARY_DIR = SCRIPT_DIR / "skills_library"
MANIFEST_PATH = LIBRARY_DIR / "manifest.json"
GLOBAL_SKILLS_DIR = Path.home() / ".claude" / "skills"

EXCLUDE_DIRS = {".git", "node_modules", ".terraform", "__pycache__", ".venv"}


# --- Core helpers -----------------------------------------------------

def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def discover_bundled_skills() -> list:
    return sorted(
        p.parent.name for p in LIBRARY_DIR.glob("*/SKILL.md")
    )


def _collect_relative_paths(target: Path) -> list:
    """One-pass walk of target, returning POSIX-style relative file paths,
    skipping common noise directories."""
    paths = []
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in files:
            rel = Path(root, f).relative_to(target).as_posix()
            paths.append(rel)
    return paths


def _pattern_matches_any(pattern: str, paths: list) -> bool:
    candidates = [pattern]
    if pattern.startswith("**/"):
        candidates.append(pattern[3:])
    return any(fnmatch.fnmatch(p, c) for p in paths for c in candidates)


def detect_relevant_skills(target: Path, manifest: dict) -> dict:
    """Return {skill_name: [matched_glob, ...]} for skills with >=1 match."""
    paths = _collect_relative_paths(target)
    results = {}
    for skill_name, rule in manifest["skills"].items():
        matched = [g for g in rule["detect_globs"] if _pattern_matches_any(g, paths)]
        if matched:
            results[skill_name] = matched
    return results


def copy_skill(skill_name: str, source_root: Path, dest_root: Path,
               force: bool, dry_run: bool) -> str:
    src = source_root / skill_name
    dst = dest_root / skill_name
    if not (src / "SKILL.md").exists():
        return "missing-source"
    if dst.exists() and not force:
        return "skipped-exists"
    if dry_run:
        return "would-install"
    dest_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, dirs_exist_ok=True)
    return "installed"


# --- Subcommand implementations ----------------------------------------

def cmd_install(args) -> int:
    skills = discover_bundled_skills()
    if not skills:
        print(f"No skills found in {LIBRARY_DIR}")
        return 1
    for skill_name in skills:
        status = copy_skill(skill_name, LIBRARY_DIR, GLOBAL_SKILLS_DIR, args.force, args.dry_run)
        print(f"{skill_name}: {status}")
    return 0


def cmd_generate(args) -> int:
    manifest = load_manifest()
    target = args.target.resolve()

    if args.all:
        detected = {name: ["--all"] for name in manifest["skills"]}
    else:
        detected = detect_relevant_skills(target, manifest)

    if not detected:
        print(f"No relevant skills detected for {target}")
        print("(use --all to install the full library regardless)")
        return 0

    dest_root = target / ".claude" / "skills"
    for skill_name, matched in detected.items():
        src = GLOBAL_SKILLS_DIR / skill_name
        if not (src / "SKILL.md").exists():
            print(f"{skill_name}: SOURCE MISSING in {GLOBAL_SKILLS_DIR} (run 'install' first) -- skipping")
            continue
        status = copy_skill(skill_name, GLOBAL_SKILLS_DIR, dest_root, args.force, args.dry_run)
        reason = ", ".join(matched)
        print(f"{skill_name}: {status}  (matched: {reason})")
    return 0


def cmd_list(args) -> int:
    manifest = load_manifest()
    target = args.target.resolve()
    detected = detect_relevant_skills(target, manifest)
    dest_root = target / ".claude" / "skills"

    print(f"Target: {target}\n")
    for skill_name in manifest["skills"]:
        is_relevant = skill_name in detected
        already_installed = (dest_root / skill_name / "SKILL.md").exists()
        available = (GLOBAL_SKILLS_DIR / skill_name / "SKILL.md").exists()

        marker = "x" if is_relevant else " "
        if already_installed:
            status = "installed"
        elif available:
            status = "available"
        else:
            status = "NOT IN ~/.claude/skills (run install)"
        reason = f" via {', '.join(detected[skill_name])}" if is_relevant else ""
        print(f"[{marker}] {skill_name:25s} {status:35s}{reason}")
    return 0


def cmd_setup_task(args) -> int:
    target = args.target.resolve()
    vscode_dir = target / ".vscode"
    tasks_path = vscode_dir / "tasks.json"

    new_task = {
        "label": "Generate Claude Skills",
        "type": "shell",
        "command": "py",
        "args": [
            str(SCRIPT_DIR / "generate_skills.py"),
            "generate",
            "--target", "${workspaceFolder}",
        ],
        "problemMatcher": [],
        "presentation": {"reveal": "always", "panel": "shared"},
    }

    if tasks_path.exists():
        try:
            data = json.loads(tasks_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"ERROR: could not parse {tasks_path} as JSON ({e}).")
            print("If it contains comments (JSONC), add the task manually:")
            print(json.dumps(new_task, indent=2))
            return 1
    else:
        data = {"version": "2.0.0", "tasks": []}

    existing = [t for t in data.get("tasks", []) if t.get("label") == new_task["label"]]
    if existing and not args.force:
        print(f"Task '{new_task['label']}' already exists in {tasks_path} (use --force to replace)")
        return 0

    data["tasks"] = [t for t in data.get("tasks", []) if t.get("label") != new_task["label"]]
    data["tasks"].append(new_task)

    vscode_dir.mkdir(parents=True, exist_ok=True)
    tasks_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote 'Generate Claude Skills' task to {tasks_path}")
    return 0


# --- argparse setup ------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="generate_skills.py",
        description="Detect a project's stack and install matching Claude Code skills.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_install = sub.add_parser("install", aliases=["sync-library"],
                                help="Copy bundled skills_library/* into ~/.claude/skills/")
    p_install.add_argument("--force", action="store_true")
    p_install.add_argument("--dry-run", action="store_true")
    p_install.set_defaults(func=cmd_install)

    p_generate = sub.add_parser("generate",
                                 help="Detect target project stack and install matching skills")
    p_generate.add_argument("--target", type=Path, default=Path.cwd())
    p_generate.add_argument("--all", action="store_true",
                             help="Install every skill in the personal library, ignoring detection")
    p_generate.add_argument("--force", action="store_true",
                             help="Overwrite skills already present in <target>/.claude/skills/")
    p_generate.add_argument("--dry-run", action="store_true")
    p_generate.set_defaults(func=cmd_generate)

    p_list = sub.add_parser("list",
                             help="Show detected/relevant skills for a target without writing anything")
    p_list.add_argument("--target", type=Path, default=Path.cwd())
    p_list.set_defaults(func=cmd_list)

    p_setup = sub.add_parser("setup-task",
                              help="Add a 'Generate Claude Skills' task to <target>/.vscode/tasks.json")
    p_setup.add_argument("--target", type=Path, default=Path.cwd())
    p_setup.add_argument("--force", action="store_true")
    p_setup.set_defaults(func=cmd_setup_task)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
