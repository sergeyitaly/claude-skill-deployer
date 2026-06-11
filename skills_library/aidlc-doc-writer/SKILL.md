---
name: aidlc-doc-writer
description: Write or update AI-DLC methodology documents (inception, per-unit construction, operations, verification) following the standard phase-to-folder mapping and per-document structure conventions, reading the actual source/infra code first so docs reflect what's implemented. Complements aidlc-tracker (status/gates) by producing the document content itself. Use when asked to write/update an AIDLC doc, document a phase/stage, or generate AIDLC scaffolding for a new project.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# AI-DLC Doc Writer

Produces the actual content of AI-DLC documents. For status/phase tracking
and approval gates, see `aidlc-tracker` — use that skill first to confirm
which doc is next and that writing it now is appropriate.

## 1. Find the doc root

Check, in this order, for the AI-DLC docs root (and check project rules /
`CLAUDE.md` for an explicit remap — some projects redirect the official
default to a different path):
- `docs/aidlc/`
- `aidlc-docs/` (official AI-DLC default)
- `.aidlc-docs/`

If none exist and the user wants to start, see "Bootstrapping" below.

## 2. Read source first

Before writing **any** construction doc, read the relevant implementation
files (`.tf`, `.cs`, `.js`, `.py`, etc.) for the unit being documented. Docs
must describe what is actually implemented, not what was planned — if they
diverge, the code wins and the doc should say what's real.

## 3. Phase → folder → required files

| Phase | Folder | Required files |
|-------|--------|-----------------|
| Inception | `<root>/inception/` | architecture-decisions, architecture-diagram, execution-plan, team-responsibilities, requirements-clarification-questions |
| Construction (per unit) | `<root>/construction/` | infrastructure-design, CONSTRUCTION-REVIEW, functional-design, nfr-requirements, nfr-design |
| Construction / Build & Test | `<root>/construction/build-and-test/` | build-instructions, unit-test-instructions, integration-test-instructions, build-and-test-summary |
| Operations | `<root>/operations/` | deployment-runbook, deployment-readiness-checklist, e2e-testing-guide |
| Verification | `<root>/verification/` | self-check-report, interview-prep |

## 4. Per-document structure

- **functional-design.md**: data model table → business rules (`BR-NN`
  format) → service interaction diagram.
- **nfr-requirements.md**: numbered NFRs grouped by category (Throughput,
  Latency, Availability, Scalability, Security, Observability, Retention,
  Cost, Maintainability, Resilience).
- **nfr-design.md**: one section per NFR category → pattern name → code/HCL
  snippet from actual source → file reference.
- **build-and-test/**: `build-instructions` covers the CI stage diagram;
  `unit-test-instructions` lists every test case; `integration-test-instructions`
  covers smoke + e2e; `build-and-test-summary` has a pipeline gate map + NFR
  coverage table + known gaps.

## 5. Append-only audit log

Always use an append (e.g. `str_replace`/`Edit` adding a new line, never a
full overwrite) to add entries to `<root>/audit.md`:

```
| {ISO date} | {Phase} - {Stage} | {Description} | Agent |
```

Match whatever format already exists — if it's a different table shape or
per-entry block style, follow that instead of reformatting.

## 6. Retroactive docs

Any doc created after the work it describes was already implemented must say
so in its header:

```
**Status:** ✅ Approved (retroactively documented — reflects implemented code)
```

## 7. Update the doc index

After adding any new doc, add it to the project's AIDLC doc index/table if
one exists (commonly a table in `README.md`, `INDEX.md`, or a `DEMO/`
walkthrough doc) — search for an existing phase table before assuming none
exists.

## 8. Bootstrapping a new project

If no AIDLC docs exist yet:
1. Create `docs/aidlc/aidlc-state.md` with a Project table (scenario, repo,
   doc root), a Current Status table (phase=Inception, stage=Workspace
   Detection, status, last-updated=today), an empty Phase Completion table,
   and an Artifacts Index pointing at phase subfolders.
2. Create `docs/aidlc/audit.md` with a header and the table format from
   step 5.
3. Create `inception/`, `construction/`, `operations/` subfolders only as
   their first artifact is written — don't pre-create empty folders.
4. Hand off to `aidlc-tracker` for ongoing status/gate tracking.
