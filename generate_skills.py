#!/usr/bin/env python3
"""generate_skills.py -- detect a project's stack and install matching
Claude Code skills from a personal global skill library.

Usage:
  python generate_skills.py install [--force] [--dry-run]
  python generate_skills.py generate [--target PATH] [--all] [--force] [--dry-run]
  python generate_skills.py list [--target PATH]
  python generate_skills.py setup-task [--target PATH] [--force]
  python generate_skills.py apply-session [--target PATH]
  python generate_skills.py apply-profile [--target PATH]
  python generate_skills.py sync-branch [--target PATH]
  python generate_skills.py sync-agents [--target PATH] [--agents claude,cursor]
  python generate_skills.py sync [--target PATH]
  python generate_skills.py hooks install [--target PATH] [--full]
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
HOOKS_SOURCE = SCRIPT_DIR / "extension" / "resources" / "hooks"

from cost_utils import print_cost_summary, should_skip_expensive_skill, TIER_SESSION_TOKENS, parse_tier  # noqa: E402
from record_runs import record_skill_run  # noqa: E402
from cost_intelligence import print_cost_report, weekly_summary_from_runs  # noqa: E402
from skills_sync import (  # noqa: E402
    apply_local_profile,
    enabled_agents,
    install_hooks,
    process_session_apply,
    run_sync,
    sync_branch_profile,
    sync_workspace_agents,
)

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
    manifest = load_manifest()
    skills = discover_bundled_skills()
    if not skills:
        print(f"No skills found in {LIBRARY_DIR}")
        return 1
    if args.dry_run:
        print_cost_summary(skills, manifest)

    for skill_name in skills:
        rule = manifest["skills"].get(skill_name, {})
        skip = should_skip_expensive_skill(skill_name, rule, dry_run=args.dry_run or args.force)
        if skip:
            print(f"{skill_name}: skipped ({skip})")
            continue
        status = copy_skill(skill_name, LIBRARY_DIR, GLOBAL_SKILLS_DIR, args.force, args.dry_run)
        print(f"{skill_name}: {status}")
        if status == "installed" and not args.dry_run:
            tier = parse_tier(rule.get("cost_estimate"))
            record_skill_run(
                skill_name,
                "claude",
                TIER_SESSION_TOKENS.get(tier, TIER_SESSION_TOKENS["medium"]),
                True,
                action="install",
                target=Path.cwd(),
                metadata={"matched": "global-install"},
            )
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

    if args.dry_run:
        print_cost_summary(list(detected.keys()), manifest)

    dest_root = target / ".claude" / "skills"
    for skill_name, matched in detected.items():
        rule = manifest["skills"].get(skill_name, {})
        skip = should_skip_expensive_skill(skill_name, rule, dry_run=args.dry_run or args.force)
        if skip:
            print(f"{skill_name}: skipped ({skip})  (matched: {', '.join(matched)})")
            continue
        src = GLOBAL_SKILLS_DIR / skill_name
        if not (src / "SKILL.md").exists():
            print(f"{skill_name}: SOURCE MISSING in {GLOBAL_SKILLS_DIR} (run 'install' first) -- skipping")
            continue
        status = copy_skill(skill_name, GLOBAL_SKILLS_DIR, dest_root, args.force, args.dry_run)
        reason = ", ".join(matched)
        print(f"{skill_name}: {status}  (matched: {reason})")
        if status == "installed" and not args.dry_run:
            tier = parse_tier(rule.get("cost_estimate"))
            record_skill_run(
                skill_name,
                "claude",
                TIER_SESSION_TOKENS.get(tier, TIER_SESSION_TOKENS["medium"]),
                True,
                action="generate",
                target=target,
                metadata={"matched": matched},
            )
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


def _print_apply_result(label: str, payload: dict) -> None:
    if payload.get("applied"):
        result = payload.get("result") or {}
        installed = result.get("installed") or []
        overrides = result.get("overrides_applied", 0)
        print(f"{label}: applied — installed {len(installed)} skill(s), overrides {overrides}")
        for skill in installed:
            print(f"  + {skill}")
        skipped = result.get("skipped") or []
        for skill in skipped:
            print(f"  ? skipped {skill}")
    else:
        print(f"{label}: {payload.get('reason', 'no changes')}")


def cmd_apply_session(args) -> int:
    target = args.target.resolve()
    payload = process_session_apply(LIBRARY_DIR, target)
    _print_apply_result("apply-session", payload)
    return 0


def cmd_apply_profile(args) -> int:
    target = args.target.resolve()
    payload = apply_local_profile(LIBRARY_DIR, target)
    if payload.get("applied"):
        _print_apply_result("apply-profile", payload)
        invalid = payload.get("invalid") or []
        for skill in invalid:
            print(f"  ! invalid (not in catalog): {skill}")
    else:
        print(f"apply-profile: {payload.get('reason', 'no changes')}")
    return 0


def cmd_sync_branch(args) -> int:
    target = args.target.resolve()
    payload = sync_branch_profile(LIBRARY_DIR, target)
    if payload.get("applied"):
        _print_apply_result(f"sync-branch ({payload.get('branch')})", payload)
    else:
        print(f"sync-branch: {payload.get('reason', 'no changes')}")
    return 0


def cmd_sync_agents(args) -> int:
    target = args.target.resolve()
    agent_ids = None
    if args.agents:
        agent_ids = [a.strip() for a in args.agents.split(",") if a.strip()]
    results = sync_workspace_agents(LIBRARY_DIR, target, agent_ids)
    if not results:
        print("sync-agents: nothing to sync (multiAgent off or no enabled agents)")
        return 0
    for row in results:
        print(f"{row.get('agent')}/{row.get('skill')}: {row.get('status')}")
    return 0


def cmd_sync(args) -> int:
    target = args.target.resolve()
    summary = run_sync(LIBRARY_DIR, target)
    print("sync: session")
    _print_apply_result("  session", summary["session"])
    print("sync: profile")
    _print_apply_result("  profile", summary["profile"])
    print("sync: branch")
    if summary["branch"].get("applied"):
        _print_apply_result(f"  branch ({summary['branch'].get('branch')})", summary["branch"])
    else:
        print(f"  branch: {summary['branch'].get('reason', 'no changes')}")
    agent_rows = summary.get("agents") or []
    print(f"sync: agents ({len(agent_rows)} operation(s))")
    for row in agent_rows[:20]:
        print(f"  {row.get('agent')}/{row.get('skill')}: {row.get('status')}")
    if len(agent_rows) > 20:
        print(f"  ... and {len(agent_rows) - 20} more")
    return 0


def cmd_hooks_install(args) -> int:
    target = args.target.resolve()
    if not HOOKS_SOURCE.is_dir():
        print(f"ERROR: hook scripts not found at {HOOKS_SOURCE}")
        print("Run from the claude-skills-deployer repo root, or copy .claude/hooks/ manually.")
        return 1
    result = install_hooks(
        target,
        HOOKS_SOURCE,
        full=args.full,
        library_dir=LIBRARY_DIR,
        git_branch_hook=args.git_branch_hook,
    )
    print(f"hooks install: copied {len(result['copied'])} file(s) to .claude/hooks/")
    if result.get("settings_updated"):
        print("hooks install: updated .claude/settings.json")
    for note in result.get("agent_hooks") or []:
        print(f"hooks install: {note}")
    if result.get("git_branch_hook"):
        print("hooks install: git post-checkout branch-sync hook installed")
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

    p_cost = sub.add_parser("cost-report", help="Show cost intelligence report and optimization suggestions")
    p_cost.add_argument("--target", type=Path, default=Path.cwd())
    p_cost.add_argument("--weekly", action="store_true", help="Include week-over-week summary")
    p_cost.set_defaults(func=cmd_cost_report)

    p_apply_session = sub.add_parser(
        "apply-session",
        help="Process session-skill-apply-request.json (SessionStart hook output)",
    )
    p_apply_session.add_argument("--target", type=Path, default=Path.cwd())
    p_apply_session.set_defaults(func=cmd_apply_session)

    p_apply_profile = sub.add_parser(
        "apply-profile",
        help="Install skills from pending .claude/profile.local.json",
    )
    p_apply_profile.add_argument("--target", type=Path, default=Path.cwd())
    p_apply_profile.set_defaults(func=cmd_apply_profile)

    p_sync_branch = sub.add_parser(
        "sync-branch",
        help="Apply saved branch skill profile for the current git branch",
    )
    p_sync_branch.add_argument("--target", type=Path, default=Path.cwd())
    p_sync_branch.set_defaults(func=cmd_sync_branch)

    p_sync_agents = sub.add_parser(
        "sync-agents",
        help="Mirror effective .claude/skills set to Cursor/Kiro/Copilot paths",
    )
    p_sync_agents.add_argument("--target", type=Path, default=Path.cwd())
    p_sync_agents.add_argument(
        "--agents",
        help="Comma-separated agent ids (default: from cli-config or all except claude)",
    )
    p_sync_agents.set_defaults(func=cmd_sync_agents)

    p_sync = sub.add_parser(
        "sync",
        help="Run apply-session, apply-profile, sync-branch, and sync-agents in order",
    )
    p_sync.add_argument("--target", type=Path, default=Path.cwd())
    p_sync.set_defaults(func=cmd_sync)

    p_hooks = sub.add_parser("hooks", help="Install Claude Code / agent session hooks")
    hooks_sub = p_hooks.add_subparsers(dest="hooks_command", required=True)
    p_hooks_install = hooks_sub.add_parser("install", help="Copy hook scripts and register in .claude/settings.json")
    p_hooks_install.add_argument("--target", type=Path, default=Path.cwd())
    p_hooks_install.add_argument(
        "--full",
        action="store_true",
        help="Also install budget/session/focus UserPromptSubmit hooks and official-skills SessionStart",
    )
    p_hooks_install.add_argument(
        "--git-branch-hook",
        action="store_true",
        help="Install git post-checkout hook to run branch-sync.js on branch switch",
    )
    p_hooks_install.set_defaults(func=cmd_hooks_install)

    return parser


def cmd_cost_report(args) -> int:
    target = args.target.resolve()
    rc = print_cost_report(target)
    if args.weekly:
        summary = weekly_summary_from_runs(target)
        print(f"\nWeekly: ${summary['total']:.2f} ({summary['total_tokens']:,} tokens)")
        print(f"Change vs prior week: {summary['vs_last_week_percent']:+.1f}%")
    return rc


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
