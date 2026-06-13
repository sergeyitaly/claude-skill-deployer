---
name: profile-init
description: AUTO-START when .claude/learning/profile-init-request.json exists with status pending, on a new git branch, or at SessionStart hook injection. Initialize a personal skill profile for the current branch based on team position (DevOps, QA, AQA, Backend, Frontend, BA, Resource Manager, Team Lead). Reads the extension skill catalog, selects skills, writes .claude/profile.local.json (gitignored). Do not wait for the user to ask — run immediately when triggered.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Profile Init

Set up a **personal, local-only** skill profile for the **current git branch** and the user's **position on the team**. You choose which skills to enable by reading the live catalog — there is no fixed role-to-skills map.

## Automatic start (do not wait for the user)

Run this skill **immediately** when any of these is true:

1. **SessionStart hook** injected context starting with `[Claude Skills] PROFILE INIT REQUIRED`.
2. **`.claude/learning/profile-init-request.json`** exists with `"status": "pending"`.
3. The user switched to a **new git branch** with no applied profile yet.

When auto-started, read `agentInstructions` from the request file and execute without asking "should I run profile-init?".

## When to run manually

- The user asks to initialize their profile or init skills for this branch.
- **Claude Skills: Init Profile for Current Branch** was just used.

## Inputs (read in order)

1. **`.claude/learning/profile-init-request.json`** — branch, position, `agentInstructions`, paths, relevant skill names, `status`.
2. **`.claude/position.local.json`** — saved role.
3. **`.claude/learning/skills-catalog.json`** — extension snapshot of all available skills. Refresh with **Claude Skills: Refresh Skill Catalog** if missing.
4. **Branch context** — `git branch --show-current`, diff vs main if helpful.
5. **Optional** — one clarifying question only if the branch name is ambiguous.

If position is missing, ask the user to pick one or run **Claude Skills: Set Your Position**.

## How to select skills

**You decide** — no hardcoded role map.

Use position, branch/task context, catalog descriptions, and `isRelevant` / `matchedGlobs`. Prefer a focused set (often 5–15 skills **including** the required platform set below).

### Required platform skills (always include)

Every profile **must** include these extension platform skills in `skills[]` (also marked `requiredForProfileInit: true` in the catalog). The extension merges them on apply even if you omit one:

| Skill | Purpose |
|---|---|
| `self-learning` | Record run outcomes and learned fixes |
| `file-style-conventions` | File hygiene (YAML newline, no emoji outside `.md`) |
| `skill-creator` | Create and optimize skills |
| `skill-usage-insights` | Usage/KPI reports from `runs.jsonl` |
| `skill-feedback-adaptation` | User feedback + task skill proposals |
| `skill-official-updater` | Sync official Anthropic skills |

Add role/branch-specific skills **on top** of this set. Override the list via `claudeSkills.profileInit.requiredSkills` in extension settings.

If required skills are accidentally deleted or locally disabled, the extension **auto-recovers** them when you switch to a new git branch without a saved profile (`claudeSkills.profileInit.recoverRequiredSkillsOnNewBranch`, default on).

Do **not** commit skill files or profile JSON to git.

## Output — write `.claude/profile.local.json`

Also write or refine **`.claude/learning/task-skill-proposals.json`** so the Usage Report shows your ranked branch skill proposals (the extension may seed this file when init starts — overwrite with your agent-selected set).

```json
{
  "version": 1,
  "branch": "feature/my-task",
  "role": "devops",
  "roleLabel": "DevOps",
  "skills": ["self-learning", "file-style-conventions", "skill-creator", "skill-usage-insights", "skill-feedback-adaptation", "skill-official-updater", "ci-pipeline-debug", "terraform-module-ops"],
  "rationale": {
    "self-learning": "Required platform skill — run logging.",
    "skill-creator": "Required platform skill — skill authoring.",
    "ci-pipeline-debug": "Branch touches GitLab CI."
  },
  "initBy": "agent",
  "status": "pending",
  "createdAt": "2026-06-12T12:00:00.000Z"
}
```

- `branch` must match the current git branch.
- `skills` — only names from `skills-catalog.json`.
- `status` — `"pending"` when writing; extension sets `"applied"`.

The extension auto-applies when `claudeSkills.profileInit.autoApplyProfileFile` is on (default).

## Multi-agent note

Catalog and profile paths are always under **`.claude/`** (extension contract). This skill is synced to Cursor, Kiro, and Copilot; the same files apply regardless of which agent runs this skill.

## Re-init

Overwrite `.claude/profile.local.json` with a new `skills` array and `"status": "pending"`. Reset request file `status` to `"pending"` if needed.
