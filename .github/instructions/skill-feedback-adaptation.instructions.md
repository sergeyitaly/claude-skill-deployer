---
name: "skill-feedback-adaptation"
description: "AUTO-START on new agent session/window (injected by profile-init-watch for Claude, Cursor, Kiro, Copilot) and on new tasks — analyze the prompt and repo, write task-skill-proposals.json, then read top proposed skills before other work. Also register user disagreement into skill-feedback.jsonl when the user says no, not, wrong, stop, or disagrees with agent output."
applyTo:
  - **/.claude/learning/skill-feedback.jsonl
  - **/.claude/learning/task-skill-proposals.json
  - **/.claude/learning/**
---

# skill-feedback-adaptation

# Skill Feedback Adaptation

Track when users push back on agent answers or skill-driven behavior, surface
inefficiency in the Usage Report dashboard, and propose skills when a new task
starts.

## AUTO-START (new session / new task)

**Run immediately — before any other task work — when any of these is true:**

- Session hook injects `[Claude Skills] NEW SESSION` (Claude Code SessionStart,
  Cursor `sessionStart`, Kiro `agentSpawn`, Copilot SessionStart via
  `profile-init-watch.js`).
- User opens a **new chat** or describes a **new task** (feature, bug, review,
  assessment) in their first message.
- User asks which skills fit the current task.

**Do this first:**

1. Read this skill (you are here).
2. Run **section 3** below — overwrite `.claude/learning/task-skill-proposals.json`
   for the user's actual task (not a stale profile-init seed).
3. **Read** the top 3–5 proposed `SKILL.md` files from `.claude/skills/` before
   answering.

Do not skip step 2 because proposals already exist on disk.

## Storage layout

```
.claude/learning/
  skill-feedback.jsonl       append-only negative/correction feedback (gitignore)
  task-skill-proposals.json  latest task → skill proposal set (gitignore)
```

Both files are machine-local (same as `runs.jsonl`). Do not commit them.

## 1. Detect and record negative user feedback

**When to record:** The user's latest message expresses disagreement with what
the agent just did or said — not merely asking a clarifying question.

Common signals (case-insensitive, at start or embedded):
`no`, `nope`, `not that`, `not what`, `wrong`, `incorrect`, `don't`, `do not`,
`stop`, `bad idea`, `that's not`, `disagree`, `actually,`, `you missed`,
`you forgot`, `instead`.

**Steps:**

1. Identify which **skill** drove the rejected behavior:
   - Skill explicitly invoked this turn (Read of `SKILL.md`).
   - Else the most recent skill in `.claude/learning/runs.jsonl` with
     `metadata.invoked: true` in this session.
   - Else `"general"` if no skill applies.
2. Append to `.claude/learning/skill-feedback.jsonl` (one JSON object per line):

```json
{"ts": "2026-06-13T10:00:00.000Z", "skill": "ci-pipeline-debug", "sentiment": "negative",
 "signal": "no", "user_text": "no, that's the wrong job", "context": "Agent suggested lint stage name from main branch",
 "session_id": "...", "agent": "claude"}
```

3. Optionally append an `E-NN` entry to `session-learnings.md` if the correction
   reveals a durable fix (see [[self-learning]]).
4. Briefly acknowledge: feedback recorded for `<skill>` — it will appear in the
   Usage Report inefficiency panel.

**CLI helper** (from project root):

```bash
py record_feedback.py ci-pipeline-debug --signal "no" --user-text "no wrong job" --context "Suggested wrong CI stage"
```

## 2. Dashboard inefficiency (extension)

The VS Code **Usage Report** reads `skill-feedback.jsonl` and shows an
**Inefficient skills** panel:

- **Inefficiency %** — scales with negative feedback count (more feedback →
  higher % and deeper red heat).
- **Update suggestion** — short actionable hint per skill.
- Skills with 3+ negative reports are prioritized.

You do not need to regenerate this manually — the extension computes it on
report open. After recording feedback, tell the user they can open
**Claude Skills: Show Usage Report** to see updated scores.

### High token usage notification

When a **git branch** or active **task** (from `task-skill-proposals.json`)
uses more than the configured share of monthly credits (default **50%**, setting
`claudeSkills.skillFeedback.monthlyCreditThresholdPercent`), the extension shows
a popup offering to **Apply suggested skills** from the proposal set.

Settings (`claudeSkills.skillFeedback.*`):

- `promptOnHighUsage` — enable/disable the popup (default on).
- `monthlyCreditThresholdPercent` — threshold % (default 50).
- `monthlyCreditsUsd` — monthly budget baseline; `0` uses daily budget × 30 or
  30-day workspace spend.

Manual apply: **Claude Skills: Apply Suggested Skills for Current Task**.

## 3. Propose skills for a new task

**When to run:** AUTO-START (above), user starts a clearly **new task** (new
feature, bug area, refactor scope) — especially the first message describing
what they want to build or fix — or asks "which skills should I use for this?".

**Steps:**

1. Read the user's task prompt (goal, files mentioned, stack).
2. Scan the repo: `Glob`/`Grep` for file types, CI configs, infra, docs.
3. Read the skill library `manifest.json` (extension bundled
   `skills_library/manifest.json` or `~/.claude/skills/` catalog /
   `.claude/learning/skills-catalog.json`).
4. Cross-reference:
   - `detect_globs` matches in the workspace
   - Task keywords vs skill names/descriptions
   - Already installed skills in `.claude/skills/`
   - Past negative feedback — **deprioritize** skills with high inefficiency in
     `skill-feedback.jsonl` unless no alternative exists
5. Write `.claude/learning/task-skill-proposals.json`:

```json
{
  "version": 1,
  "generatedAt": "2026-06-13T10:05:00.000Z",
  "taskSummary": "Fix GitLab CI deploy stage failing on feature branch",
  "promptExcerpt": "deploy job fails after terraform plan...",
  "proposals": [
    {"name": "ci-pipeline-debug", "reason": "GitLab CI failure debugging", "confidence": 90, "installed": true},
    {"name": "terraform-plan-review", "reason": "Task mentions terraform plan errors", "confidence": 75, "installed": false}
  ]
}
```

6. Present the top 3–5 proposals in chat with install hint (extension tree or
   `generate_skills.py install <name>`).

Regenerate this file when the task scope changes materially — overwrite the
previous proposals.

## 4. Integration with other skills

- **[[self-learning]]** — run outcomes (`runs.jsonl`); feedback is complementary
  (user sentiment vs command exit codes).
- **[[skill-usage-insights]]** — KPI report; include inefficiency from
  `skill-feedback.jsonl` when analyzing skill health.
- **[[profile-init]]** — branch profile picks skills; task proposals are
  narrower and session-scoped.

## 5. Reporting

On request ("skill feedback status", "inefficient skills"):
- Count entries per skill in `skill-feedback.jsonl`.
- Summarize latest `task-skill-proposals.json` if present.
- Point to Usage Report for visual heat map.
