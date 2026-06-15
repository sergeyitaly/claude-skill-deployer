#!/usr/bin/env python3
"""Headless apply/sync layer for Claude Skills — works without VS Code.

Mirrors extension logic for session skill apply, profile apply, branch profiles,
multi-agent mirror sync, and Claude Code hook installation.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_REQUIRED_SKILLS = [
    "self-learning",
    "file-style-conventions",
    "skill-creator",
    "skill-usage-insights",
    "skill-feedback-adaptation",
    "skill-official-updater",
]

DEFAULT_FEATURES = {
    "sessionSkillAdaptation": True,
    "autoApplyTaskProposals": True,
    "branchProfiles": True,
    "multiAgent": True,
}

DEFAULT_ENABLED_AGENTS = ["claude", "cursor", "kiro", "copilot"]

SESSION_APPLY_REQUEST = Path(".claude") / "learning" / "session-skill-apply-request.json"
SESSION_APPLY_STATE = Path(".claude") / "learning" / "session-skill-apply-state.json"
BRANCH_PROFILES_PATH = Path.home() / ".claude" / "learning" / "branch-profiles.json"
GLOBAL_SKILLS_DIR = Path.home() / ".claude" / "skills"

HOOK_FILES = [
    "session-size-watch.js",
    "budget-watch.js",
    "context-focus-watch.js",
    "practical-focus-watch.js",
    "task-drift-watch.js",
    "hookPlatform.js",
    "task-skill-focus.js",
    "skill-invoke-watch.js",
    "official-skills-watch.js",
    "profile-init-watch.js",
    "session-apply.js",
    "branch-sync.js",
    "usageParse.js",
]

SESSION_START_MATCHER = "startup|resume|clear"
ATTRIBUTION_MATCHER = "Skill|Read|read|fs_read|fileread"


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict | list | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def cli_config_path(target: Path) -> Path:
    return target / ".claude" / "learning" / "cli-config.json"


def load_cli_config(target: Path) -> dict:
    parsed = read_json(cli_config_path(target))
    if not isinstance(parsed, dict):
        return {}
    return parsed


def merge_required_skills(skill_names: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in [*DEFAULT_REQUIRED_SKILLS, *skill_names]:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def feature_enabled(target: Path, key: str) -> bool:
    cfg = load_cli_config(target)
    features = cfg.get("features") if isinstance(cfg.get("features"), dict) else {}
    if key in features:
        return bool(features[key])
    return DEFAULT_FEATURES.get(key, True)


def load_agents_manifest(library_dir: Path) -> dict:
    path = library_dir / "agents.json"
    data = read_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("agents"), dict):
        raise FileNotFoundError(f"agents.json not found or invalid: {path}")
    return data


def enabled_agents(library_dir: Path, target: Path | None = None) -> list[str]:
    cfg = load_cli_config(target) if target else {}
    agents_cfg = cfg.get("agents") if isinstance(cfg.get("agents"), dict) else {}
    configured = agents_cfg.get("enabled")
    if isinstance(configured, list) and configured:
        return [str(a) for a in configured]
    manifest = load_agents_manifest(library_dir)
    return list(manifest["agents"].keys()) or DEFAULT_ENABLED_AGENTS


def get_git_branch(target: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=target,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        branch = out.stdout.strip()
        if out.returncode == 0 and branch and branch != "HEAD":
            return branch
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def get_git_origin_url(target: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=target,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        url = out.stdout.strip()
        return url if out.returncode == 0 and url else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def repo_key_for(target: Path) -> str | None:
    origin = get_git_origin_url(target)
    basis = origin if origin else str(target.resolve())
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def read_local_settings(target: Path) -> dict:
    path = target / ".claude" / "settings.local.json"
    data = read_json(path)
    return data if isinstance(data, dict) else {}


def read_skill_overrides(target: Path) -> dict[str, str]:
    overrides = read_local_settings(target).get("skillOverrides")
    return overrides if isinstance(overrides, dict) else {}


def set_skill_override(target: Path, skill: str, value: str | None) -> None:
    path = target / ".claude" / "settings.local.json"
    settings = read_local_settings(target)
    overrides = dict(read_skill_overrides(target))
    if value is None:
        overrides.pop(skill, None)
    else:
        overrides[skill] = value
    if overrides:
        settings["skillOverrides"] = overrides
    else:
        settings.pop("skillOverrides", None)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    _ensure_git_exclude(target, ".claude/settings.local.json")


def _ensure_git_exclude(target: Path, entry: str) -> None:
    git_dir = target / ".git"
    if not git_dir.is_dir():
        return
    exclude = git_dir / "info" / "exclude"
    normalized = entry.replace("\\", "/")
    existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
    if any(line.strip() == normalized for line in existing.splitlines()):
        return
    exclude.parent.mkdir(parents=True, exist_ok=True)
    prefix = "" if not existing or existing.endswith("\n") else "\n"
    with exclude.open("a", encoding="utf-8") as fh:
        fh.write(f"{prefix}{normalized}\n")


def is_skill_committed_on_branch(target: Path, skill: str) -> bool:
    rel = f".claude/skills/{skill}"
    try:
        out = subprocess.run(
            ["git", "ls-tree", "-r", "HEAD", "--name-only", "--", rel],
            cwd=target,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return out.returncode == 0 and bool(out.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        return False


def mark_skill_personal_local(target: Path, skill: str) -> None:
    _ensure_git_exclude(target, f".claude/skills/{skill}/")


def list_installed_skills(target: Path) -> list[str]:
    skills_dir = target / ".claude" / "skills"
    if not skills_dir.is_dir():
        return []
    return sorted(
        p.name
        for p in skills_dir.iterdir()
        if p.is_dir() and (p / "SKILL.md").is_file()
    )


def list_effective_enabled_skills(target: Path) -> list[str]:
    overrides = read_skill_overrides(target)
    return [s for s in list_installed_skills(target) if overrides.get(s) != "off"]


def resolve_skill_source(skill: str, library_dir: Path, target: Path) -> Path | None:
    global_dir = GLOBAL_SKILLS_DIR / skill / "SKILL.md"
    library = library_dir / skill / "SKILL.md"
    workspace = target / ".claude" / "skills" / skill / "SKILL.md"
    if global_dir.is_file():
        return GLOBAL_SKILLS_DIR
    if library.is_file():
        return library_dir
    if workspace.is_file():
        return target / ".claude" / "skills"
    return None


def copy_skill(skill: str, source_root: Path, dest_root: Path, force: bool = False) -> str:
    src = source_root / skill
    dst = dest_root / skill
    if not (src / "SKILL.md").is_file():
        return "missing-source"
    if dst.exists() and not force:
        return "skipped-exists"
    dest_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, dirs_exist_ok=True)
    return "installed"


def apply_branch_profile(
    library_dir: Path,
    target: Path,
    profile: dict,
    *,
    remove_extra: bool = False,
    sync_agents: bool | None = None,
) -> dict:
    dest_root = target / ".claude" / "skills"
    installed = set(list_installed_skills(target))
    desired = set(profile.get("skills") or [])
    result = {"installed": [], "removed": [], "overrides_applied": 0, "skipped": []}

    for skill in profile.get("skills") or []:
        if skill in installed:
            continue
        source_root = resolve_skill_source(skill, library_dir, target)
        if not source_root:
            result["skipped"].append(skill)
            continue
        status = copy_skill(skill, source_root, dest_root)
        if status in ("installed", "skipped-exists"):
            result["installed"].append(skill)
            installed.add(skill)
            if not is_skill_committed_on_branch(target, skill):
                mark_skill_personal_local(target, skill)
        else:
            result["skipped"].append(skill)

    current_overrides = read_skill_overrides(target)
    profile_overrides = profile.get("skillOverrides") or {}

    for skill in list(installed):
        if skill in desired:
            if current_overrides.get(skill) == "off":
                set_skill_override(target, skill, None)
                result["overrides_applied"] += 1
            continue
        if is_skill_committed_on_branch(target, skill):
            if current_overrides.get(skill) != "off":
                set_skill_override(target, skill, "off")
                result["overrides_applied"] += 1
            continue
        if remove_extra:
            skill_dir = dest_root / skill
            if skill_dir.is_dir():
                shutil.rmtree(skill_dir)
                result["removed"].append(skill)

    for skill, value in profile_overrides.items():
        if current_overrides.get(skill) != value:
            set_skill_override(target, skill, value)
            result["overrides_applied"] += 1

    should_sync = sync_agents if sync_agents is not None else feature_enabled(target, "multiAgent")
    if should_sync:
        sync_workspace_agents(library_dir, target)

    return result


def read_branch_store() -> dict:
    data = read_json(BRANCH_PROFILES_PATH)
    if isinstance(data, dict) and isinstance(data.get("repos"), dict):
        return data
    return {"version": 1, "repos": {}}


def write_branch_store(store: dict) -> None:
    BRANCH_PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(BRANCH_PROFILES_PATH, store)


def load_branch_profile(target: Path, branch: str) -> dict | None:
    key = repo_key_for(target)
    if not key:
        return None
    store = read_branch_store()
    profile = store.get("repos", {}).get(key, {}).get("branches", {}).get(branch)
    return profile if isinstance(profile, dict) else None


def save_branch_profile(target: Path, library_dir: Path | None = None) -> dict | None:
    if not feature_enabled(target, "branchProfiles"):
        return None
    branch = get_git_branch(target)
    key = repo_key_for(target)
    if not branch or not key:
        return None
    profile = {
        "branch": branch,
        "skills": list_effective_enabled_skills(target),
        "skillOverrides": read_skill_overrides(target),
        "updatedAt": _utc_now(),
        "workspacePath": str(target.resolve()),
        "remoteUrl": get_git_origin_url(target),
    }
    store = read_branch_store()
    repo = store["repos"].setdefault(
        key,
        {
            "remoteUrl": profile.get("remoteUrl"),
            "workspacePath": profile["workspacePath"],
            "branches": {},
        },
    )
    repo["remoteUrl"] = profile.get("remoteUrl") or repo.get("remoteUrl")
    repo["workspacePath"] = profile["workspacePath"]
    repo["branches"][branch] = profile
    repo["lastBranch"] = branch
    write_branch_store(store)
    return profile


def merge_profile_init_skills(selected: list[str], required: list[str] | None = None) -> list[str]:
    req = required if required is not None else DEFAULT_REQUIRED_SKILLS
    seen: set[str] = set()
    out: list[str] = []
    for name in [*req, *selected]:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def read_session_apply_request(target: Path) -> dict | None:
    data = read_json(target / SESSION_APPLY_REQUEST)
    if not isinstance(data, dict) or data.get("version") != 1:
        return None
    if not isinstance(data.get("skills"), list):
        return None
    return data


def should_apply_session_request(target: Path, request: dict) -> bool:
    if not request.get("sessionId") or not request.get("skills"):
        return False
    state = read_json(target / SESSION_APPLY_STATE)
    if isinstance(state, dict) and state.get("lastSessionId") == request.get("sessionId"):
        return False
    return True


def apply_proposed_skills(library_dir: Path, target: Path, skill_names: list[str]) -> dict:
    unique = merge_required_skills(list(dict.fromkeys(s for s in skill_names if s)))
    if not unique:
        return {"installed": [], "removed": [], "overrides_applied": 0, "skipped": []}
    branch = get_git_branch(target) or "unknown"
    profile = {
        "branch": branch,
        "skills": unique,
        "skillOverrides": {},
        "updatedAt": _utc_now(),
        "workspacePath": str(target.resolve()),
    }
    result = apply_branch_profile(library_dir, target, profile, remove_extra=False)
    save_branch_profile(target, library_dir)
    _refresh_proposal_installed_flags(target)
    return result


def process_session_apply(library_dir: Path, target: Path) -> dict:
    if not feature_enabled(target, "sessionSkillAdaptation"):
        return {"applied": False, "reason": "sessionSkillAdaptation disabled"}
    request = read_session_apply_request(target)
    if not request:
        return {"applied": False, "reason": "no request"}
    if not should_apply_session_request(target, request):
        return {"applied": False, "reason": "already applied for session", "request": request}
    result = apply_proposed_skills(library_dir, target, request["skills"])
    write_json_atomic(
        target / SESSION_APPLY_STATE,
        {
            "version": 1,
            "lastSessionId": request["sessionId"],
            "lastAppliedAt": _utc_now(),
            "lastSkillCount": len(request["skills"]),
        },
    )
    return {"applied": True, "result": result, "request": request}


def _refresh_proposal_installed_flags(target: Path) -> None:
    path = target / ".claude" / "learning" / "task-skill-proposals.json"
    data = read_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("proposals"), list):
        return
    installed = set(list_installed_skills(target))
    changed = False
    for prop in data["proposals"]:
        if not isinstance(prop, dict):
            continue
        flag = prop.get("name") in installed
        if prop.get("installed") != flag:
            prop["installed"] = flag
            changed = True
    if changed:
        write_json_atomic(path, data)


def apply_local_profile(library_dir: Path, target: Path) -> dict:
    profile_path = target / ".claude" / "profile.local.json"
    profile = read_json(profile_path)
    if not isinstance(profile, dict):
        return {"applied": False, "reason": "no profile.local.json"}
    if profile.get("status") == "applied":
        return {"applied": False, "reason": "already applied"}
    skills = profile.get("skills")
    if not isinstance(skills, list) or not skills:
        return {"applied": False, "reason": "no skills in profile"}

    branch = get_git_branch(target)
    if branch and profile.get("branch") and profile.get("branch") != branch:
        return {"applied": False, "reason": "branch mismatch"}

    catalog = read_json(target / ".claude" / "learning" / "skills-catalog.json")
    catalog_names = set()
    if isinstance(catalog, dict) and isinstance(catalog.get("skills"), list):
        for entry in catalog["skills"]:
            if isinstance(entry, dict) and entry.get("name"):
                catalog_names.add(entry["name"])

    merged = merge_profile_init_skills([str(s) for s in skills])
    valid = [s for s in merged if not catalog_names or s in catalog_names]
    invalid = [s for s in merged if catalog_names and s not in catalog_names]
    if not valid:
        return {"applied": False, "reason": "no valid skills", "invalid": invalid}

    branch_profile = {
        "branch": profile.get("branch") or branch or "unknown",
        "skills": valid,
        "skillOverrides": {},
        "updatedAt": _utc_now(),
        "workspacePath": str(target.resolve()),
    }
    result = apply_branch_profile(library_dir, target, branch_profile, remove_extra=False)
    save_branch_profile(target, library_dir)

    applied = {
        **profile,
        "skills": valid,
        "status": "applied",
        "appliedAt": _utc_now(),
    }
    write_json_atomic(profile_path, applied)

    request_path = target / ".claude" / "learning" / "profile-init-request.json"
    req = read_json(request_path)
    if isinstance(req, dict) and req.get("status") == "pending":
        req["status"] = "completed"
        req["completedAt"] = _utc_now()
        write_json_atomic(request_path, req)

    return {"applied": True, "result": result, "invalid": invalid, "profile": applied}


def sync_branch_profile(library_dir: Path, target: Path) -> dict:
    if not feature_enabled(target, "branchProfiles"):
        return {"applied": False, "reason": "branchProfiles disabled"}
    branch = get_git_branch(target)
    if not branch:
        return {"applied": False, "reason": "not a git repo"}
    profile = load_branch_profile(target, branch)
    if not profile:
        saved = save_branch_profile(target, library_dir)
        return {"applied": False, "reason": "no saved profile; captured current", "saved": saved}
    result = apply_branch_profile(library_dir, target, profile, remove_extra=False)
    return {"applied": True, "branch": branch, "result": result}


def _strip_frontmatter(raw: str) -> str:
    match = re.match(r"^---\r?\n[\s\S]*?\r?\n---\r?\n?", raw)
    return raw[match.end() :].strip() if match else raw.strip()


def _parse_description(raw: str) -> str | None:
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", raw)
    if not match:
        return None
    for line in match.group(1).splitlines():
        if line.startswith("description:"):
            val = line.split(":", 1)[1].strip().strip('"').strip("'")
            return val or None
    return None


def build_copilot_instructions(skill: str, skill_md: Path, detect_globs: list[str]) -> str:
    raw = skill_md.read_text(encoding="utf-8")
    body = _strip_frontmatter(raw)
    description = _parse_description(raw)
    globs = detect_globs or ["**/*"]
    lines = ["---"]
    if description:
        esc = description.replace("\\", "\\\\").replace('"', '\\"')
        lines.extend([f'name: "{skill}"', f'description: "{esc}"'])
    if len(globs) == 1:
        lines.append(f'applyTo: "{globs[0]}"')
    else:
        lines.append("applyTo:")
        lines.extend(f"  - {g}" for g in globs)
    lines.extend(["---", "", f"# {skill}", "", body, ""])
    return "\n".join(lines)


def sync_workspace_agents(library_dir: Path, target: Path, agent_ids: list[str] | None = None) -> list[dict]:
    if not feature_enabled(target, "multiAgent"):
        return []
    manifest = json.loads((library_dir / "manifest.json").read_text(encoding="utf-8"))
    agents_manifest = load_agents_manifest(library_dir)
    ids = agent_ids or [a for a in enabled_agents(library_dir, target) if a != "claude"]
    effective = set(list_effective_enabled_skills(target))
    claude_dir = target / ".claude" / "skills"
    results: list[dict] = []

    for agent_id in ids:
        agent = agents_manifest["agents"].get(agent_id)
        if not agent or not agent.get("supportsWorkspace"):
            continue
        dest_root = target / agent["workspaceDir"]
        fmt = agent.get("format", "skill-md")

        if fmt == "skill-md":
            dest_root.mkdir(parents=True, exist_ok=True)
            if dest_root.is_dir():
                for child in dest_root.iterdir():
                    if child.is_dir() and child.name not in effective:
                        shutil.rmtree(child, ignore_errors=True)
            for skill in effective:
                if (dest_root / skill / "SKILL.md").is_file():
                    results.append({"agent": agent_id, "skill": skill, "status": "skipped-exists"})
                    continue
                if (claude_dir / skill / "SKILL.md").is_file():
                    status = copy_skill(skill, claude_dir, dest_root)
                else:
                    source_root = resolve_skill_source(skill, library_dir, target)
                    if not source_root:
                        results.append({"agent": agent_id, "skill": skill, "status": "source-missing"})
                        continue
                    status = copy_skill(skill, source_root, dest_root)
                results.append({"agent": agent_id, "skill": skill, "status": status})
        elif fmt == "copilot-instructions":
            dest_root.mkdir(parents=True, exist_ok=True)
            for f in dest_root.glob("*.instructions.md"):
                skill_name = f.name.replace(".instructions.md", "")
                if skill_name not in effective:
                    f.unlink(missing_ok=True)
            for skill in effective:
                skill_md = claude_dir / skill / "SKILL.md"
                if not skill_md.is_file():
                    root = resolve_skill_source(skill, library_dir, target)
                    if not root:
                        results.append({"agent": agent_id, "skill": skill, "status": "source-missing"})
                        continue
                    skill_md = root / skill / "SKILL.md"
                globs = manifest.get("skills", {}).get(skill, {}).get("detect_globs", ["**/*"])
                dest_file = dest_root / f"{skill}.instructions.md"
                dest_file.write_text(build_copilot_instructions(skill, skill_md, globs), encoding="utf-8")
                results.append({"agent": agent_id, "skill": skill, "status": "written"})

    return results


def _read_settings(target: Path) -> dict:
    path = target / ".claude" / "settings.json"
    data = read_json(path)
    return data if isinstance(data, dict) else {}


def _write_settings(target: Path, settings: dict) -> None:
    write_json_atomic(target / ".claude" / "settings.json", settings)


def _ensure_session_start_hook(settings: dict, filename: str, command: str) -> bool:
    settings.setdefault("hooks", {})
    session = settings["hooks"].setdefault("SessionStart", [])
    for entry in session:
        for hook in entry.get("hooks", []):
            if filename in hook.get("command", ""):
                return False
    session.append(
        {
            "matcher": SESSION_START_MATCHER,
            "hooks": [{"type": "command", "command": command, "timeout": 20}],
        }
    )
    return True


def _ensure_post_tool_hook(settings: dict, filename: str, command: str) -> bool:
    settings.setdefault("hooks", {})
    post = settings["hooks"].setdefault("PostToolUse", [])
    for entry in post:
        for hook in entry.get("hooks", []):
            if filename in hook.get("command", ""):
                return False
    post.append(
        {
            "matcher": ATTRIBUTION_MATCHER,
            "hooks": [{"type": "command", "command": command, "timeout": 8}],
        }
    )
    return True


def _ensure_user_prompt_hook(settings: dict, filename: str, command: str) -> bool:
    settings.setdefault("hooks", {})
    entries = settings["hooks"].setdefault("UserPromptSubmit", [])
    for entry in entries:
        for hook in entry.get("hooks", []):
            if filename in hook.get("command", ""):
                return False
    entries.append({"matcher": "", "hooks": [{"type": "command", "command": command, "timeout": 8}]})
    return True


def _install_git_branch_sync_hook(target: Path) -> bool:
    git_dir = target / ".git"
    if not git_dir.is_dir():
        return False
    hooks_dir = git_dir / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    hook_path = hooks_dir / "post-checkout"
    marker = "claude-skills branch-sync"
    body = (
        "#!/bin/sh\n"
        f"# {marker}\n"
        'ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0\n'
        '[ -f "$ROOT/.claude/hooks/branch-sync.js" ] || exit 0\n'
        'node "$ROOT/.claude/hooks/branch-sync.js" "$ROOT" 2>/dev/null || true\n'
    )
    if hook_path.is_file():
        existing = hook_path.read_text(encoding="utf-8")
        if marker in existing:
            return False
        hook_path.write_text(existing.rstrip() + "\n\n" + body, encoding="utf-8")
        hook_path.chmod(0o755)
        return True
    hook_path.write_text(body, encoding="utf-8")
    hook_path.chmod(0o755)
    return True


def install_hooks(
    target: Path,
    hooks_source: Path,
    *,
    full: bool = False,
    library_dir: Path | None = None,
    git_branch_hook: bool = False,
) -> dict:
    dest_hooks = target / ".claude" / "hooks"
    dest_hooks.mkdir(parents=True, exist_ok=True)
    copied = []
    for name in HOOK_FILES:
        src = hooks_source / name
        if src.is_file():
            shutil.copy2(src, dest_hooks / name)
            copied.append(name)

    (target / ".claude" / "learning").mkdir(parents=True, exist_ok=True)
    settings = _read_settings(target)
    changed = False

    profile_cmd = 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/profile-init-watch.js" claude'
    changed |= _ensure_session_start_hook(settings, "profile-init-watch.js", profile_cmd)

    invoke_cmd = 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/skill-invoke-watch.js" claude'
    changed |= _ensure_post_tool_hook(settings, "skill-invoke-watch.js", invoke_cmd)

    if full:
        for filename, var_name in [
            ("session-size-watch.js", "session-size-watch.js"),
            ("budget-watch.js", "budget-watch.js"),
            ("context-focus-watch.js", "context-focus-watch.js"),
            ("practical-focus-watch.js", "practical-focus-watch.js"),
            ("task-drift-watch.js", "task-drift-watch.js"),
        ]:
            cmd = f'node "${{CLAUDE_PROJECT_DIR}}/.claude/hooks/{var_name}"'
            changed |= _ensure_user_prompt_hook(settings, filename, cmd)
        official_cmd = 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/official-skills-watch.js"'
        changed |= _ensure_session_start_hook(settings, "official-skills-watch.js", official_cmd)

    if changed:
        _write_settings(target, settings)

    agent_hooks: list[str] = []
    lib = library_dir
    if lib is None:
        candidate = hooks_source.parent.parent.parent / "skills_library"
        lib = candidate if candidate.is_dir() else None

    if lib and lib.is_dir():
        ids = set(enabled_agents(lib, target))
        if "cursor" in ids:
            agent_hooks.extend(_install_cursor_profile_init_hook(target, hooks_source))
            if full:
                agent_hooks.extend(_install_cursor_cost_control_hooks(target, hooks_source))
        if "kiro" in ids:
            agent_hooks.extend(_install_kiro_profile_init_hook(target, hooks_source))
            if full:
                agent_hooks.extend(_install_kiro_cost_control_hooks(target, hooks_source))
        if "copilot" in ids:
            agent_hooks.extend(_install_copilot_profile_init_hook(target, hooks_source))
            if full:
                agent_hooks.extend(_install_copilot_cost_control_hooks(target, hooks_source))

    git_hook = _install_git_branch_sync_hook(target) if git_branch_hook else False

    return {
        "copied": copied,
        "settings_updated": changed,
        "agent_hooks": agent_hooks,
        "git_branch_hook": git_hook,
    }


def _install_cursor_profile_init_hook(target: Path, hooks_source: Path) -> list[str]:
    cursor_hooks = target / ".cursor" / "hooks"
    cursor_hooks.mkdir(parents=True, exist_ok=True)
    src = hooks_source / "profile-init-watch.js"
    if src.is_file():
        shutil.copy2(src, cursor_hooks / "profile-init-watch.js")
    cmd = "node .cursor/hooks/profile-init-watch.js cursor"
    data = read_json(target / ".cursor" / "hooks.json") or {"version": 1, "hooks": {}}
    data.setdefault("hooks", {})
    entries = data["hooks"].setdefault("sessionStart", [])
    if not any(cmd in (e.get("command") or "") for e in entries):
        entries.append({"command": cmd, "timeout": 20})
        write_json_atomic(target / ".cursor" / "hooks.json", data)
        return ["cursor profile-init"]
    return []


def _install_kiro_profile_init_hook(target: Path, hooks_source: Path) -> list[str]:
    kiro_hooks = target / ".kiro" / "hooks"
    kiro_hooks.mkdir(parents=True, exist_ok=True)
    src = hooks_source / "profile-init-watch.js"
    if src.is_file():
        shutil.copy2(src, kiro_hooks / "profile-init-watch.js")
    hook_file = kiro_hooks / "claude-skills-skill-invoke-profile-init.kiro.hook"
    payload = {
        "name": "claude-skills profile-init",
        "description": "claude-skills-skill-invoke-profile-init",
        "enabled": True,
        "when": {"type": "sessionStart"},
        "then": {"type": "runCommand", "command": "node .claude/hooks/profile-init-watch.js kiro"},
    }
    write_json_atomic(hook_file, payload)
    return ["kiro profile-init"]


def _install_copilot_profile_init_hook(target: Path, hooks_source: Path) -> list[str]:
    gh_hooks = target / ".github" / "hooks"
    gh_hooks.mkdir(parents=True, exist_ok=True)
    cmd = "node .claude/hooks/profile-init-watch.js copilot"
    hook_file = gh_hooks / "claude-skills-skill-invoke-profile-init.json"
    payload = {
        "version": 1,
        "hooks": {
            "SessionStart": [{"type": "command", "bash": cmd, "powershell": cmd, "timeoutSec": 20}],
            "sessionStart": [{"type": "command", "bash": cmd, "powershell": cmd, "timeoutSec": 20}],
        },
    }
    write_json_atomic(hook_file, payload)
    return ["copilot profile-init"]


COST_CONTROL_PROMPT_HOOKS = [
    ("session-size-watch.js", "claude-skills-session-size", True),
    ("budget-watch.js", "claude-skills-budget", True),
    ("context-focus-watch.js", "claude-skills-context-focus", False),
    ("practical-focus-watch.js", "claude-skills-practical-focus", False),
    ("task-drift-watch.js", "claude-skills-task-drift", False),
]


def _copy_cost_control_scripts(target: Path, hooks_source: Path, script: str, needs_usage_parse: bool) -> None:
    dest_claude = target / ".claude" / "hooks"
    dest_cursor = target / ".cursor" / "hooks"
    dest_claude.mkdir(parents=True, exist_ok=True)
    dest_cursor.mkdir(parents=True, exist_ok=True)
    src = hooks_source / script
    if src.is_file():
        shutil.copy2(src, dest_claude / script)
        shutil.copy2(src, dest_cursor / script)
    platform_src = hooks_source / "hookPlatform.js"
    if platform_src.is_file():
        shutil.copy2(platform_src, dest_claude / "hookPlatform.js")
        shutil.copy2(platform_src, dest_cursor / "hookPlatform.js")
    if needs_usage_parse:
        usage_src = hooks_source / "usageParse.js"
        if usage_src.is_file():
            shutil.copy2(usage_src, dest_claude / "usageParse.js")
            shutil.copy2(usage_src, dest_cursor / "usageParse.js")


def _install_cursor_cost_control_hooks(target: Path, hooks_source: Path) -> list[str]:
    installed: list[str] = []
    cursor_hooks = target / ".cursor" / "hooks"
    cursor_hooks.mkdir(parents=True, exist_ok=True)
    data = read_json(target / ".cursor" / "hooks.json") or {"version": 1, "hooks": {}}
    data.setdefault("hooks", {})
    entries = data["hooks"].setdefault("beforeSubmitPrompt", [])
    for script, _marker, needs_usage in COST_CONTROL_PROMPT_HOOKS:
        _copy_cost_control_scripts(target, hooks_source, script, needs_usage)
        cmd = f"node .cursor/hooks/{script} cursor"
        if not any(cmd in (e.get("command") or "") for e in entries):
            entries.append({"command": cmd, "timeout": 8})
            installed.append(f"cursor {script}")
    write_json_atomic(target / ".cursor" / "hooks.json", data)
    return installed


def _install_kiro_cost_control_hooks(target: Path, hooks_source: Path) -> list[str]:
    installed: list[str] = []
    kiro_hooks = target / ".kiro" / "hooks"
    kiro_hooks.mkdir(parents=True, exist_ok=True)
    for script, marker, needs_usage in COST_CONTROL_PROMPT_HOOKS:
        _copy_cost_control_scripts(target, hooks_source, script, needs_usage)
        hook_file = kiro_hooks / f"{marker}.kiro.hook"
        payload = {
            "name": f"claude-skills {marker}",
            "description": marker,
            "enabled": True,
            "when": {"type": "promptSubmit"},
            "then": {
                "type": "runCommand",
                "command": f"node .claude/hooks/{script} kiro",
                "timeout": 8,
            },
        }
        write_json_atomic(hook_file, payload)
        installed.append(f"kiro {script}")
    return installed


def _install_copilot_cost_control_hooks(target: Path, hooks_source: Path) -> list[str]:
    installed: list[str] = []
    gh_hooks = target / ".github" / "hooks"
    gh_hooks.mkdir(parents=True, exist_ok=True)
    for script, marker, needs_usage in COST_CONTROL_PROMPT_HOOKS:
        _copy_cost_control_scripts(target, hooks_source, script, needs_usage)
        cmd = f"node .claude/hooks/{script} copilot"
        hook_file = gh_hooks / f"{marker}.json"
        payload = {
            "version": 1,
            "hooks": {
                "UserPromptSubmit": [{"type": "command", "bash": cmd, "powershell": cmd, "timeoutSec": 8}],
                "userPromptSubmitted": [{"type": "command", "bash": cmd, "powershell": cmd, "timeoutSec": 8}],
            },
        }
        write_json_atomic(hook_file, payload)
        installed.append(f"copilot {script}")
    return installed


def run_sync(library_dir: Path, target: Path) -> dict:
    """Apply session request, pending profile, branch profile, then mirror agents."""
    out: dict[str, Any] = {}
    out["session"] = process_session_apply(library_dir, target)
    out["profile"] = apply_local_profile(library_dir, target)
    out["branch"] = sync_branch_profile(library_dir, target)
    out["agents"] = sync_workspace_agents(library_dir, target)
    return out
