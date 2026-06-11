---
name: self-learning
description: Maintain a project-local self-learning base of task/command outcomes — record successes and failures with timestamps, durations, and fixes; generate a patterns report (pass rates, recurring errors, known fixes); and surface a learned hint before retrying something that failed before. Use at the start of a session to check learned hints, after running a non-trivial command/skill to record the outcome, when asked "what failed before" or "what did we learn", or to record a manual decision/learning.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Self-Learning

A small, project-agnostic accumulated-experience store. The goal: the second
time something fails, fixing it is instant because the fix is already
written down — and reliable commands don't need re-verifying every session.

## Storage layout

All state lives under `.claude/learning/` in the target project (create it on
first use):

```
.claude/learning/
  runs.jsonl              append-only log of recorded outcomes (gitignore this)
  patterns.md             auto-generated report (gitignore this)
  session-learnings.md    human/agent-curated decisions and fixes (commit this)
```

Add `.claude/learning/runs.jsonl` and `.claude/learning/patterns.md` to
`.gitignore` if not already ignored — they're machine-local history.
`session-learnings.md` should be committed: it's the durable, reviewable
output.

## Run record schema (one JSON object per line in runs.jsonl)

```json
{"ts": "2026-06-11T14:32:00", "skill": "terraform", "action": "validate",
 "rc": 0, "duration": 4.2, "error": "", "hint": "", "note": ""}
```

- `skill`/`action`: a short identifier for what was run (e.g. skill name +
  subcommand, or `"task"` + a short task name).
- `rc`: 0 for success, non-zero for failure.
- `error`: first meaningful error line (truncate to ~200 chars), empty on
  success.
- `hint`: a short fix description if one is known (see "Deriving hints"
  below); empty if none.
- `note`: optional free-text context.

## 1. Before running something that might be flaky or previously failed

Before re-running a command/skill, check `.claude/learning/runs.jsonl` (most
recent matching `skill`+`action`, scan backwards) and `session-learnings.md`
for a recorded hint. If found, surface it first:

```
[LEARNED] Previous failure hint for '<skill> <action>':
          <hint text>
```

Then proceed — the hint informs the approach, it doesn't replace doing the
work.

## 2. After running something non-trivial

Append a record to `runs.jsonl` with the outcome. Then regenerate
`patterns.md` (see structure below) by aggregating all records:

- **Reliable commands** — 100% pass rate over 3+ runs: list as
  `skill | action | runs | avg duration`.
- **Commands with known failures** — for each `skill action` with at least
  one failure: pass rate, up to 3 distinct observed error snippets, and any
  known-fix hints recorded for it.
- **Recent runs** — last ~20 records as a table (timestamp, skill, action,
  rc, duration, error).

## 3. Deriving hints for new failures

When recording a failure with no existing hint, check the error text against
fix patterns already written in `session-learnings.md` (keyword match against
the "What happened"/"Pattern" text of existing `E-NN` entries). If one
matches, reuse its fix as the `hint`. If nothing matches, leave `hint` empty
— a human or a later session can add one via "manual learning" below.

## 4. Manual learning entries

When the user states a decision, a fix, or "we learned X", append a
structured entry to `session-learnings.md` rather than just replying in
chat — this is what makes it available to future sessions (load this file
into context at the start of any session on this project).

- **Successes** (`### S-NN — <label>`): a pattern/decision that worked,
  with date, the pattern itself, and source.
- **Errors/fixes** (`### E-NN — <label>`): what happened, with date, a short
  description, and the fix if known.

Number sequentially per category (`S-01`, `S-02`, ... / `E-01`, `E-02`, ...)
by scanning existing headers for the highest number used.

## 5. Reporting

On request ("what failed before", "learning status", "what have we
learned"):
- Summarize `patterns.md` if it exists (pass rates per command, open known
  failures with fixes).
- Summarize `session-learnings.md` (counts of S-/E- entries, most recent
  few).
- If `.claude/learning/` doesn't exist yet, say so — there's no history yet,
  not an error.

## 6. Clearing history

Only clear `runs.jsonl`/`patterns.md` (machine history) on explicit user
request — never clear `session-learnings.md` without explicit confirmation,
since it's curated and reviewable.
