---
name: "profile-init"
description: "Initialize a personal skill profile for the current git branch based on the user's team position (DevOps, QA, AQA, Backend, Frontend, BA, Resource Manager, Team Lead). Reads the extension-generated skill catalog, selects skills for this branch/task, writes .claude/profile.local.json, and lets the extension install them locally (not committed to git). Use when starting work on a new branch, when asked to \"init profile\", or when .claude/learning/profile-init-request.json exists."
applyTo:
  - **/.claude/learning/profile-init-request.json
  - **/.claude/profile.local.json
---

# profile-init

# Profile Init

Set up a **personal, local-only** skill profile for the **current git branch** and the user's **position on the team**. You choose which skills to enable by reading the live catalog — there is no fixed role-to-skills map.

## When to run

- The user asks to initialize their profile, init skills for this branch, or set up skills for their role.
- `.claude/learning/profile-init-request.json` exists (extension wrote it after the user started init).
- A new branch has no skill profile yet and the user wants agent-guided setup.

## Inputs (read in order)

1. **`.claude/learning/profile-init-request.json`** (if present) — branch name, position, paths, and a short prompt.
2. **`.claude/position.local.json`** — saved role (`devops`, `qa`, `aqa`, `backend-developer`, `frontend-developer`, `ba`, `resource-manager`, `team-lead`).
3. **`.claude/learning/skills-catalog.json`** — extension snapshot of all available skills (`name`, `description`, `detectGlobs`, `isRelevant`, `installedInWorkspace`, `costEstimate`). Refresh with command **Claude Skills: Refresh Skill Catalog** if missing or stale.
4. **Branch context** — current branch name (`git branch --show-current`), recent files or diff vs main if helpful for task scope.
5. **Optional** — ask one clarifying question if the branch name is ambiguous (e.g. "Is this branch mainly infra, app code, or docs?").

If position is missing, ask the user to pick one:

- DevOps, QA, AQA, Backend Developer, Frontend Developer, BA, Resource Manager, Team Lead

Or tell them to run **Claude Skills: Set Your Position**.

## How to select skills

**You decide** which skills fit — do not use a hardcoded list.

Use:

- **Position** — primary lens (e.g. QA → testing/CI skills; BA → docs/comms/spreadsheet skills).
- **Branch / task** — what this branch is likely about (feature name, paths, `isRelevant` + `matchedGlobs` in the catalog).
- **Descriptions** in the catalog — match intent, not just keywords.
- **Restraint** — prefer a focused set (often 5–15 skills **including** the required platform set) over installing everything.

### Required platform skills (always include)

Every profile **must** include these extension platform skills in `skills[]` (catalog entries have `requiredForProfileInit: true`). The extension merges them on apply even if omitted:

- `self-learning` — run outcomes and learned fixes
- `file-style-conventions` — file hygiene
- `skill-creator` — create and optimize skills
- `skill-usage-insights` — usage/KPI reports
- `skill-feedback-adaptation` — user feedback and task proposals
- `skill-official-updater` — sync official Anthropic skills

Add role/branch-specific skills on top. Configurable via `claudeSkills.profileInit.requiredSkills`.

If required skills are deleted or locally disabled, the extension reinstalls them on a new git branch without a saved profile (`claudeSkills.profileInit.recoverRequiredSkillsOnNewBranch`, default on).

Always include **`profile-init`** only until init completes; you may omit it from the final profile if the user prefers a minimal set.

Do **not** commit skill files or profile JSON to git. Output goes only to `.claude/profile.local.json`.

## Output — write `.claude/profile.local.json`

```json
{
  "version": 1,
  "branch": "feature/my-task",
  "role": "devops",
  "roleLabel": "DevOps",
  "skills": ["self-learning", "file-style-conventions", "skill-creator", "skill-usage-insights", "skill-feedback-adaptation", "skill-official-updater", "ci-pipeline-debug", "terraform-module-ops"],
  "rationale": {
    "self-learning": "Required platform skill.",
    "skill-creator": "Required platform skill.",
    "ci-pipeline-debug": "Branch touches GitLab CI; primary debugging skill for this task.",
    "terraform-module-ops": "Repo has .tf files and role is DevOps."
  },
  "initBy": "agent",
  "status": "pending",
  "createdAt": "2026-06-12T12:00:00.000Z"
}
```

Rules:

- `branch` must match the current git branch.
- `role` / `roleLabel` must match `.claude/position.local.json`.
- `skills` — only names that exist in `skills-catalog.json`.
- `status` — always `"pending"` when writing; the extension sets `"applied"` after install.
- `rationale` — brief per-skill reason (helps the user review).

After writing the file, tell the user:

1. The extension will auto-apply if `claudeSkills.profileInit.autoApplyProfileFile` is on (default).
2. Or they can run **Claude Skills: Apply Local Profile**.
3. List the chosen skills and one-line why each fits position + branch.

## Verify

- Confirm `.claude/profile.local.json` was written and lists only catalog skill names.
- If auto-apply is enabled, skills should appear under `.claude/skills/` shortly.
- Branch profile is saved in `~/.claude/learning/branch-profiles.json` by the extension (personal, not in the repo).

## Re-init

To change skills on the same branch, re-run this skill and overwrite `.claude/profile.local.json` with a new `skills` array and `"status": "pending"`.
