# AI agent instructions (Claude Skills Manager)

This repository deploys **native GitHub Copilot instructions** under `.github/instructions/*.instructions.md`.
When you work on files matching a skill's `applyTo` globs, follow that skill's instruction file fully.

## Installed skills

| Skill | Applies when |
|---|---|
| claude-api | `**/*` |
| cross-platform-scripting | `**/*.ps1, **/*.psm1, **/*.sh, **/*.cmd, **/*.bat` — Detect the host OS (Windows/macOS/Linux) and PowerShell version (5.1 Desktop vs 7+ Core) before writing or editing scripts, and write/adapt .ps1, .sh, and .cmd scripts to match what's actually available — avoiding PS7-only syntax on PS5.1, GNU-only flags on macOS/BSD tools, and Windows-only assumptions on POSIX shells. Use before writing a new script, when a script fails with a syntax/parameter error that looks version- or OS-specific, or when asked to make a script cross-platform. |
| file-style-conventions | `**/*` — Apply two lightweight file-hygiene conventions when writing or editing files - no emoji characters outside Markdown (.md) files, and YAML files (.yml/.yaml) end with exactly one trailing newline. Use whenever creating or editing non-Markdown files that might contain emoji, or any .yml/.yaml file. |
| profile-init | `**/.claude/learning/profile-init-request.json, **/.claude/profile.local.json` — AUTO-START when .claude/learning/profile-init-request.json exists with status pending, on a new git branch, or at SessionStart hook injection. Initialize a personal skill profile for the current branch based on team position (DevOps, QA, AQA, Backend, Frontend, BA, Resource Manager, Team Lead). Reads the extension skill catalog, selects skills, writes .claude/profile.local.json (gitignored). Do not wait for the user to ask — run immediately when triggered. |
| self-learning | `**/*` — Maintain a project-local self-learning base of task/command outcomes — record successes and failures with timestamps, durations, and fixes; generate a patterns report (pass rates, recurring errors, known fixes); and surface a learned hint before retrying something that failed before. Use at the start of a session to check learned hints, after running a non-trivial command/skill to record the outcome, when asked "what failed before" or "what did we learn", or to record a manual decision/learning. |
| skill-creator | `**/*` — Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy. |
| skill-feedback-adaptation | `**/.claude/learning/skill-feedback.jsonl, **/.claude/learning/task-skill-proposals.json, **/.claude/learning/**` — Register user disagreement and negative reactions on agent answers or skill behavior into .claude/learning/skill-feedback.jsonl; on new tasks analyze the prompt and repo to write task-skill-proposals.json from the existing skill library. Use when the user says no, not, wrong, stop, or otherwise disagrees with agent output; when starting a new task or feature; or when asked about skill inefficiency, feedback adaptation, or which skills fit this task. |
| skill-official-updater | `**/*` — At the start of a new session, do a cheap check for new or updated official Anthropic skills (github.com/anthropics/skills) and offer to add or update them in skills_library/. Also use on explicit request ("check for official skill updates", "sync official skills"). |
| skill-usage-insights | `**/.claude/learning/runs.jsonl, **/.claude/skills/**` — Analyze recorded skill usage in this project (.claude/learning/runs.jsonl, written by self-learning) and the skills installed in .claude/skills/ to produce a usage and KPI report - which skills are actively used and reliable, which are failing, and which are unused or low-value, with recommendations on what to add or remove. Use when asked for "skill usage stats", "skill KPIs", "which skills should we add or remove", or "are our installed skills still useful". |
| terraform-module-ops | `**/*.tf, **/*.tfvars` — Navigate a Terraform codebase before changing it — build a module-to-resource map, identify the state backend and provider versions, run the safe local fmt/validate workflow, and flag known-drift resources or operations that need explicit user approval (full apply, destroy, state edits). Use before making Terraform changes, to find which file owns a resource, or to check whether an operation is safe to run. |
| terraform-plan-review | `**/*.tf, **/*.tfvars` — Run terraform fmt/validate/plan and review the output — categorize changes, flag destroys, and triage failures into "real bug" vs "permissions gap" vs "state drift fixable via import block". Use when asked to check Terraform state, review/run a plan, or debug a validate/plan/apply failure. |
| theme-factory | `**/*` — Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly. |

## How to use in agent mode

1. Prefer instructions whose `applyTo` matches the files you are editing.
2. If multiple match, combine them; if they conflict, ask the user.
3. Do not invent procedures — use the installed `.instructions.md` files.
4. Claude Code skills live under `.claude/skills/`; Copilot uses this folder.
