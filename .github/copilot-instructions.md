# AI agent instructions (Claude Skills Manager)

This repository deploys **native GitHub Copilot instructions** under `.github/instructions/*.instructions.md`.
When you work on files matching a skill's `applyTo` globs, follow that skill's instruction file fully.

## Installed skills

| Skill | Applies when |
|---|---|
| ci-pipeline-debug | `**/.gitlab-ci.yml, **/.gitlab/ci/*.yml, **/.github/workflows/*.yml, **/.github/workflows/*.yaml, **/azure-pipelines.yml` — Debug a failing CI pipeline stage (lint/test/validate/build/plan/apply/verify or similar) by locating the exact job definition, reproducing its commands locally, and mapping the failure to a root-cause category. Use when a pipeline/job fails and the user wants to know why or wants it fixed. |
| ci-preflight | `**/.gitlab-ci.yml, **/.gitlab/ci/*.yml, **/.github/workflows/*.yml, **/.github/workflows/*.yaml, **/azure-pipelines.yml` — Reproduce a CI pipeline's pre-merge stages (lint, test, validate, build) locally before pushing, by mapping each CI job to its exact local-equivalent command and running them in order. Use when asked to "run CI checks locally", "preflight", "what would fail in the pipeline", or before committing/pushing a change. |
| file-style-conventions | `**/*` — Apply two lightweight file-hygiene conventions when writing or editing files - no emoji characters outside Markdown (.md) files, and YAML files (.yml/.yaml) end with exactly one trailing newline. Use whenever creating or editing non-Markdown files that might contain emoji, or any .yml/.yaml file. |
| self-learning | `**/*` — Maintain a project-local self-learning base of task/command outcomes — record successes and failures with timestamps, durations, and fixes; generate a patterns report (pass rates, recurring errors, known fixes); and surface a learned hint before retrying something that failed before. Use at the start of a session to check learned hints, after running a non-trivial command/skill to record the outcome, when asked "what failed before" or "what did we learn", or to record a manual decision/learning. |
| skill-creator | `**/*` — Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy. |
| skill-feedback-adaptation | `**/.claude/learning/skill-feedback.jsonl, **/.claude/learning/task-skill-proposals.json, **/.claude/learning/**` — AUTO-START on new agent session/window (injected by profile-init-watch for Claude, Cursor, Kiro, Copilot) and on new tasks — analyze the prompt and repo, write task-skill-proposals.json, then read top proposed skills before other work. Also register user disagreement into skill-feedback.jsonl when the user says no, not, wrong, stop, or disagrees with agent output. |
| skill-official-updater | `**/*` — At the start of a new session, do a cheap check for new or updated official Anthropic skills (github.com/anthropics/skills) and automatically add or update them in skills_library/ (no user prompt). Also use on explicit request ("check for official skill updates", "sync official skills"). |
| skill-usage-insights | `**/.claude/learning/runs.jsonl, **/.claude/skills/**` — Analyze recorded skill usage in this project (.claude/learning/runs.jsonl, written by self-learning) and the skills installed in .claude/skills/ to produce a usage and KPI report - which skills are actively used and reliable, which are failing, and which are unused or low-value, with recommendations on what to add or remove. Use when asked for "skill usage stats", "skill KPIs", "which skills should we add or remove", or "are our installed skills still useful". |

## How to use in agent mode

1. Prefer instructions whose `applyTo` matches the files you are editing.
2. If multiple match, combine them; if they conflict, ask the user.
3. Do not invent procedures — use the installed `.instructions.md` files.
4. Claude Code skills live under `.claude/skills/`; Copilot uses this folder.
