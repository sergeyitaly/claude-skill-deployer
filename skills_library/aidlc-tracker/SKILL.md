---
name: aidlc-tracker
description: Track and advance an AI-DLC (AI-Driven Development Life Cycle) workflow. Reports current phase/stage/status from aidlc-state.md, what's done vs. what's next, reminds about approval gates and audit logging, and updates the tracking docs as stages complete. Use when asked "what's next", "AIDLC status", "what's left", to resume/start a phase, or to record a stage approval.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# AI-DLC Tracker

A lightweight status/reminder layer on top of the AI-DLC methodology
(Inception → Construction → Operations, with an optional Verification phase
for assessment-style projects). This skill tracks **where the project is and
what's next** — it does not replace a fuller AI-DLC rules framework if one is
checked into the repo (see "Defer to a fuller framework" below).

## 1. Find the tracking docs

Check, in this order, for the AI-DLC docs root:
- `docs/aidlc/` (common when a project remaps the official path)
- `aidlc-docs/` (the official AI-DLC default)
- `.aidlc-docs/`

Within that root, the key files are:
- `aidlc-state.md` — current phase/stage/status + phase-completion table
- `audit.md` — append-only log of stage approvals and decisions

**If none of these exist**, this project hasn't been initialized for AI-DLC
tracking — see "Bootstrapping a new project" below instead of skipping ahead.

## 2. Report current status

Read `aidlc-state.md` and summarize for the user:
- Current phase, current stage, status, blockers, last-updated date
- The Phase Completion table (which phases are ✅ Complete / 🔄 In Progress / ⬜ Not Started)
- Any non-default Extension Configuration entries

## 3. Determine what's next

Use this condensed phase/stage map (full detail lives in a fuller framework if
present — see below):

| Phase | Stages (✅ = always, ⬪ = conditional) | Typical artifacts |
|---|---|---|
| Inception | ✅ Workspace Detection → ⬪ Reverse Engineering (brownfield) → ✅ Requirements Analysis → ⬪ User Stories → ✅ Workflow Planning → ⬪ Application Design → ⬪ Units Generation | `inception/architecture-decisions.md`, `inception/execution-plan.md`, `inception/requirements-*.md` |
| Construction (per unit) | ⬪ Functional Design → ⬪ NFR Requirements → ⬪ NFR Design → ⬪ Infrastructure Design → ✅ Code Generation, then ✅ Build and Test (after all units) | `construction/functional-design.md`, `construction/nfr-*.md`, `construction/infrastructure-design.md`, `construction/build-and-test/*.md` |
| Operations | Deployment, monitoring, runbooks (project-defined) | `operations/deployment-runbook.md`, `operations/deployment-readiness-checklist.md`, `operations/e2e-testing-guide.md` |
| Verification (if used) | Self-check / readiness review, interview prep | `verification/self-check-report.md`, `verification/interview-prep.md` |

To propose "what's next":
1. Cross-reference the Phase Completion table against which artifact files
   actually exist (Glob the phase folders) — a phase marked complete with
   missing expected artifacts is worth flagging.
2. Identify the first phase/stage that is not yet ✅ Complete.
3. Propose that as the next step, but **do not start it without confirming**
   — see hard rules below.

## 4. Hard rules (apply regardless of which framework is present)

- **Never silently advance phases.** Each stage ends with an explicit
  approval question to the user. Do not start the next stage until they
  confirm.
- **Audit log is append-only.** Never overwrite `audit.md`. Add a new row/entry
  with a timestamp, the phase/stage, a short description of what happened, and
  who acted (User/Agent). Match whatever format already exists in the file —
  if it's a markdown table, append a row; if it's per-entry blocks, append a
  block. Don't reformat existing entries.
- **Update `aidlc-state.md` in the same turn work completes** — bump the
  Phase Completion table, Current Status (phase/stage/last-updated), and
  Blockers. Stale state files are worse than none.
- **Construction per-unit stages use a 2-option completion message**
  ("Request Changes" vs. "Continue to Next Stage") — don't invent a 3rd
  option or skip the gate.
- **Plan checkboxes**: if a stage produced a plan file with `- [ ]` items,
  check them off `- [x]` immediately as each item completes, in the same
  turn — not in a later cleanup pass.

## 5. Defer to a fuller framework if present

If the repo also contains a full AI-DLC rules framework — look for
`AIDLC/aidlc-rules/`, `.aidlc-rule-details/`, `.kiro/aidlc-docs/`, or
`.amazonq/aws-aidlc-rule-details/` — that framework's per-stage rule files
are authoritative for *how* to execute a stage (required questions, content
validation, message formats). Use this skill for the status/tracking layer
(steps 1-4) and load the matching rule file from that framework before
executing a specific stage's detailed steps.

## 6. Bootstrapping a new project

If no AI-DLC docs exist yet and the user wants to start tracking:
1. Create `docs/aidlc/aidlc-state.md` with: a Project table (scenario, repo,
   doc root), a Current Status table (phase=Inception, stage=Workspace
   Detection, status, last-updated=today), an empty Phase Completion table
   (Inception/Construction/Operations all ⬜ Not Started), and an Artifacts
   Index pointing at the phase subfolders.
2. Create `docs/aidlc/audit.md` with a header and the table format shown
   above (`| Timestamp (UTC) | Phase / Stage | Action | User / Agent |`).
3. Create empty `inception/`, `construction/`, `operations/` subfolders as
   work begins (don't pre-create empty folders speculatively — create each
   when its first artifact is written).
