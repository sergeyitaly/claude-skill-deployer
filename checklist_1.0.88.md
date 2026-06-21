# v1.0.88 Release Checklist — Prediction Accuracy & Attribution Quality

**Release date:** 2026-06-21
**Theme:** Fix false-positive proposals, complete hook matcher coverage, actionable Executive Summary guidance
**VSIX target:** `claude-skill-deployer-1.0.88.vsix`

---

## Background — Post-v1.0.87 Platform Audit

A full 10-phase platform review was conducted after v1.0.87 shipped. The review identified
the following evidence-based bugs from live system state:

| Source | Finding |
|---|---|
| `task-skill-proposals.json` | `infra-cost-guard` proposed at 75% confidence, reason: `"description mentions 'warn'; description mentions 'warn'"` — false positive driven by session-size hook messages in promptExcerpt |
| `task-skill-proposals.json` | Repeated "warn" token from 4× repeated `"Long session (warn)"` warning scored 15 pts each (4×15=60) → inflated confidence |
| `dashboard-snapshot.json` | `Top Action: "Reset attribution → +20 API pts"` when hooks are freshly installed and no data exists — wrong advice |
| `hookOps.ts` | `mcp__filesystem__search_files` absent from `ATTRIBUTION_HOOK_MATCHER` and Kiro `toolTypes` — skill reads via `search_files` not detected |
| `hookHandlers.ts` | Same gap: `extractSkillName` did not handle `mcp__filesystem__search_files` tool name |
| `mcp-agent-hints.md` | Did not exist — `CHANGELOG.md` read 14× (105 KB), 53k tokens wasted per analysis session |
| API Score | Precision: 0%, F1: 0% — caused by false-positive proposals that are never used |

---

## Bugs Fixed

### Bug 1 — `infra-cost-guard` false positive at 75% confidence (CRITICAL — precision killer)

**Root cause:** Two compounding issues:
1. Hook-injected session messages (`"Long session (warn) — tighten skill set..."`) were included verbatim in `promptExcerpt`, which was then tokenized and scored against skill descriptions.
2. Token deduplication was absent — the word `"warn"` appeared 4× in the excerpt (one per hook warning), each match scoring +15 against `infra-cost-guard`'s description. Total: 60 pts → 75% confidence.

**Fix A — Stop-word list expanded** (`taskSkillProposals.ts`):
Added `"warn"`, `"long"`, `"tighten"`, `"context"`, `"session"` to `LOW_SIGNAL_TASK_TOKENS`.
These words appear in cost-control and session-warning hook messages and have no task-discriminating signal.

**Fix B — Token deduplication** (`taskSkillProposals.ts`):
Changed `tokenize(promptText)` → `[...new Set(tokenize(promptText))]` in `rankAllTaskSkillProposals`.
Each unique word is now scored exactly once, regardless of how many times it appears in the prompt excerpt.

**Fix C — Two-signal requirement** (`taskSkillProposals.ts`):
Added `signalTypes` tracking in `scoreSkillForTask`. Proposals with score < 40 and fewer than 2 independent signal types (name-match, description-match, keyword-hint, glob-match, recent-history) now return `null`.
Prevents single weak text matches from producing proposals.

**Before:** `infra-cost-guard` at 75% (false positive — driven by session warning text)
**After:** filtered out (score drops to 20 after dedup, then eliminated by two-signal rule)

---

### Bug 2 — `mcp__filesystem__search_files` not in attribution hook matcher (MEDIUM — skill detection gap)

**Root cause:** v1.0.87 added `mcp__filesystem__read_file` and `mcp__filesystem__search_in_file` to `ATTRIBUTION_HOOK_MATCHER` but missed `mcp__filesystem__search_files`. When agents use `search_files` to locate SKILL.md paths (e.g. `pattern: "SKILL.md"`), the hook fires but is not matched, so skill invocations go unrecorded.

**Fix** (`hookOps.ts`):
- `ATTRIBUTION_HOOK_MATCHER` extended: `...search_in_file|mcp__filesystem__search_files`
- Kiro `toolTypes` array extended with `"mcp__filesystem__search_files"`
- `migrateAttributionHookMatcher` / `migrateAttributionPreToolMatcher` pick up new constant automatically

**Fix** (`hookHandlers.ts`):
- `extractSkillName` tool-name list extended with `"mcp__filesystem__search_files"`

---

### Bug 3 — Executive Summary "Top Action" wrong when learning loop is empty (LOW — UX)

**Root cause:** `buildExecutiveSummaryHtml` always recommended `"Reset attribution → +20 API pts"` when `attribution < 50%`. When attribution hooks were freshly installed (today, confidence 35%) and no data exists yet, reset is a no-op. The actual recommended action is to invoke skills.

**Fix** (`costDashboard.ts`):
Added a pre-check: when `learningRate < 5%` AND `precision < 5%` AND `attribution ≥ 30%` (hooks installed, just no data), the message changes to:
`"Invoke skills in agent sessions → learning loop begins"`

**Before:** `"Reset attribution → +20 API pts"` (misleading — there's nothing to reset)
**After:** `"Invoke skills in agent sessions → learning loop begins"` (correct guidance)

---

### Bug 4 — `mcp-agent-hints.md` missing (LOW — MCP efficiency waste)

**Root cause:** The file `.claude/learning/mcp-agent-hints.md` (used to cache hot-file read rules for agents) did not exist. Result: `CHANGELOG.md` was read 14× in the review session (105 KB each time), wasting ~53k tokens (~$0.16) per analysis cycle.

**Fix:** Created `.claude/learning/mcp-agent-hints.md` with rules:
- `CHANGELOG.md`: use `search_in_file` with version pattern — avoid full load
- `extension/src/`: cache directory listing within a task
- Root directory: load once at session start, do not re-scan

---

## Phase Checklist

### Phase 1 — Bug fixes verified

- [x] **taskSkillProposals.ts** — `LOW_SIGNAL_TASK_TOKENS` extended with hook-message words
- [x] **taskSkillProposals.ts** — token deduplication via `[...new Set(tokenize(promptText))]`
- [x] **taskSkillProposals.ts** — `signalTypes` tracking + two-signal requirement for score < 40
- [x] **hookOps.ts** — `ATTRIBUTION_HOOK_MATCHER` includes `mcp__filesystem__search_files`
- [x] **hookOps.ts** — Kiro `toolTypes` includes `mcp__filesystem__search_files`
- [x] **hookHandlers.ts** — `extractSkillName` handles `mcp__filesystem__search_files`
- [x] **costDashboard.ts** — `topAction` shows correct guidance when learning loop is empty
- [x] **.claude/learning/mcp-agent-hints.md** — created with CHANGELOG.md and directory cache rules

### Phase 2 — Version & release artifacts

- [x] `extension/package.json` → `"version": "1.0.88"`
- [x] `extension/CHANGELOG.md` → v1.0.88 section added
- [ ] `extension/` → `npm run package` → `claude-skill-deployer-1.0.88.vsix`
- [ ] VSIX installed locally and tested

### Phase 3 — Prediction verification

- [ ] Open Cost Intelligence Dashboard → `infra-cost-guard` no longer in proposals
- [ ] Proposal list has ≤ 3 items, all with 2+ independent signal reasons
- [ ] Executive Summary "Top Action" reads `"Invoke skills in agent sessions → learning loop begins"`
- [ ] Prediction Intelligence section shows Precision: 0%, F1: 0% (correct — no data yet)

### Phase 4 — Hook coverage verification

- [ ] Reload VS Code workspace → hook auto-migration fires for all 4 agents
- [ ] `.claude/settings.json` PostToolUse matcher contains `mcp__filesystem__search_files`
- [ ] Kiro `.kiro.hook` file contains `mcp__filesystem__search_files` in toolTypes

### Phase 5 — Regression checks

- [ ] `npm test` (extension/) → all tests pass
- [ ] `npm run compile` → zero TypeScript errors
- [ ] Existing proposals for `skill-feedback-adaptation` and `skill-usage-insights`: check confidence and reason — should still appear if they have 2+ signals (glob + installed), otherwise correctly filtered

### Phase 6 — Documentation

- [x] `checklist_1.0.88.md` — this file
- [x] `CHANGELOG.md` (root) — updated
- [x] `README.md` — updated
- [ ] Marketplace description updated (if publishing)

### Phase 7 — Commit & publish

- [ ] `git add` all changed files
- [ ] `git commit -m "feat: v1.0.88 — prediction accuracy, hook matcher, Executive Summary fix"`
- [ ] `git push origin main`

---

## API Score Impact (expected post-fix)

| Component | Before | After | Notes |
|---|---|---|---|
| Precision | 0% | 0% | Still 0 — no invocations yet, but proposals are now valid |
| Attribution | 35% | 35% | Unchanged — hooks installed, data collecting |
| Skill Efficiency | 0% | 0% | Unchanged — no ROI data |
| Learning Rate | 0% | 0% | Unchanged — first invocations not yet recorded |
| Task Completion | 100% | 100% | No failures |
| Human Correction | 100% | 100% | No corrections |
| **API Score** | **32 (F)** | **32 (F)** | Score unchanged — bugs were in noise elimination, not data |

**Key distinction:** These fixes do not raise the API score today. They eliminate false signal so that when data DOES accumulate, precision will be genuine (actual skill use / actual proposals) rather than inflated noise / inflated proposals.

---

## Known Open Items (not blocking release)

| Item | Severity | Target |
|---|---|---|
| Recommendation success chain missing (proposed→accepted→invoked→succeeded) | CRITICAL | v1.0.89 |
| ROI model uses heuristic time-saved (3/8/15 min), never empirically validated | HIGH | v1.0.89 |
| Adaptation Effectiveness Index not implemented | HIGH | v1.0.89 |
| Repository affinity model not implemented | HIGH | v1.0.89 |
| Dashboard analyze step takes 3365ms (93% of pipeline time) | MEDIUM | v1.0.89 |
| skill-feedback-adaptation and skill-usage-insights proposals may be over-filtered | LOW | Monitor |
