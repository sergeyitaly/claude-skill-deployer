# Claude Skills Manager v1.0.84 Checklist

## Source
Production Readiness Assessment v2 (2026-06-21). All items are evidence-based.
Data: 18 hook-measured invocations · 6 attributed sessions · 77 Claude sessions · $894.08 spend.
API Score baseline: 32/100. Target: ≥55/100 after this release.

---

## Phase 1: Attribution Fix — Stale Hook Port

### Bug
`ensurePostToolHookRegistered` removes legacy *filename* references (skill-invoke-watch.js)
but not legacy *port* references. The PostToolUse skill-invoke hook in `.claude/settings.json`
still points to `http://127.0.0.1:51710/hook/skill-invoke` from a pre-1.0.83 install.
`hookBaseUrl()` now returns port 4895. The pattern check (`/hook/skill-invoke` substring)
passes, so `ensurePostToolHookRegistered` returns early leaving the dead-port command in place.
Equal-split mis-attribution (20% confidence) is the downstream effect.

Root cause confirmed: `hookOps.ts` line 632, `hasPostToolHook` detects the URL pattern,
short-circuits before the new command is applied.

### Tasks
- [x] In `ensurePostToolHookRegistered` (`hookOps.ts`): after removing legacy filename entries,
  also remove any existing PostToolUse hook that includes `/hook/<hookName>` but whose command
  does NOT match `command` (the canonical curl command) — stale port replacement
- [x] Add unit test `hookOps.test.ts` — stale-port skill-invoke hook is replaced on
  `installClaudeAttributionHook` (old 51710 URL → new 4895 URL)
- [ ] Operational: run "Reset Mis-attributed Cost Data" command after hook fix (no code change)

---

## Phase 2: Proposal Engine — History Boost

### Gap
`scoreSkillForTask` in `taskSkillProposals.ts` ignores `runs.jsonl`.
A skill invoked 3 sessions ago is scored identically to one never used.
Additionally, catch-all `**/*` globs grant +20 to every skill that has one,
regardless of relevance (e.g. `theme-factory`, `claude-api`, `skill-official-updater`).

Root cause: `taskSkillProposals.ts` imports `invalidateLearningCache` from `runsStore`
but never reads run history for scoring.

### Tasks
- [x] Add `recentUsageBoost(skillName, runs)` helper in `taskSkillProposals.ts`:
  +25 if used in last 7 days, +15 if last 30 days, 0 otherwise
- [x] Pass recent runs (from `readCachedEnrichedRuns`) into `scoreSkillForTask` and apply boost
- [x] Add catch-all glob cap: when the only matched globs are `**/*`, `**/*.md`, or `**/*.*`
  (no specific extension or path), skip the +20 glob bonus entirely
- [x] Add 3 test cases to `taskSkillProposals.test.ts`:
  - Skill used 3 days ago scores ≥25 higher than identical unused skill
  - Skill used 35 days ago gets no recent boost
  - Catch-all-only glob match does not add glob bonus

---

## Phase 3: Cost Control Hooks — Enable

### Gap
Dashboard shows session-size, daily budget, context focus, and practical focus hooks all OFF.
`installCostControlHooks` exists in `hookOps.ts` but is never called for the workspace target
in the extension activation path. Hook JS files exist in `.claude/hooks/` but are not wired
into `.claude/settings.json` UserPromptSubmit section.

### Tasks
- [x] Add `ensureCostControlHooksActive` in `workspaceSkillSync.ts` parallel to
  `ensureAttributionHooksActive` — auto-installs session-size + budget hooks when not yet active
- [x] Call it in `propagateWorkspaceSkillChange` alongside attribution hook install
- [x] Update `workspaceSkillSync.test.ts` — stale "does not install" assertion updated to
  reflect new auto-install behaviour

---

## Phase 4: Profile & Manifest Cleanup

### Bug A — Archived skills still in profile
`profile.local.json` still lists `adx-schema-check`, `algorithmic-art`, `brand-guidelines`,
`canvas-design` which were removed from `manifest.json` in v1.0.83. These skills are applied
to the agent each session, adding dead context with no matching manifest entry.

Root cause: `sessionSkillApply.ts` applies profile skills without checking the manifest.

### Bug B — "manifest" false skill invocation
`runs.jsonl` and `cost-attribution.json` contain entries for `skill: "manifest"` — a false
detection caused by reading a file named `manifest` (e.g. `skills_library/manifest.json`).
This is not a real skill. It inflates cost-attribution and appears as rank-3 in the
top-skills dashboard panel ($0.133 attributed).

### Tasks
- [x] In `sessionSkillApply.ts`: filter skills list in `processSessionSkillApplyRequest` against
  `loadManifest(libraryDir)` — archived skills silently dropped, required platform skills kept
- [x] In `hookHandlers.ts` `SKILL_DENYLIST`: added `"manifest"`, `"package"`, `"readme"`,
  `"changelog"`, `"license"` — false-detection file names excluded from skill run recording
- [x] Updated `.claude/profile.local.json` — removed 4 archived skills, added `github-actions-ci`,
  `vscode-extension-publishing`, `mcp-server-creation`, `vitest-extension-testing`

---

## Phase 5: Agent Performance Index (API Score)

### New Feature
Implement the 0–100 composite KPI from the Production Readiness Assessment.

```
API = Precision×25 + AttributionCoverage×20 + SkillEfficiency×15 +
      LearningRate×15 + TaskCompletionRate×15 + HumanCorrectionRate×10
```

Each sub-score is 0–100 before weighting.

Sub-score definitions:
- **Precision**: (skills used that were also in last proposal) / (total skills used) × 100
- **Attribution**: `attribution-trust.json → scorePct × 100` (already 0–100)
- **SkillEfficiency**: clamp(netRoi / 50 × 100, 0, 100) from team-economics-cache.json
- **LearningRate**: clamp(v2HookRuns / 30 × 100, 0, 100) — grows as telemetry accumulates
- **TaskCompletion**: successRate from skill-stats (all 100% today → 100)
- **HumanCorrection**: 100 if skill-feedback.jsonl is empty/absent; decreases by 10 per entry

### Tasks
- [x] Created `extension/src/agentPerformanceIndex.ts` with `computeApiScore`
  — 6 sub-scores, weighted composite, A–F grade
- [x] Added `apiScore` field to `DashboardSnapshotPayload` in `dashboardPrecompute.ts`
- [x] `buildDashboardMainBodyHtml` (`costDashboard.ts`) now computes and renders a full
  "Agent Performance Index" panel above the efficiency metrics panel
- [x] Added 5 unit tests in `agentPerformanceIndex.test.ts`

---

## Phase 6: Audit Export Command

### New Feature
Allow teams to export skill telemetry for compliance, external analysis, or handoff.

### Tasks
- [x] Added `claudeSkills.exportTelemetry` command to `extension/package.json`
- [x] Implemented in `commandsMisc.ts` — reads runs, writes CSV with 9 columns to
  workspace root as `skill-telemetry-YYYY-MM-DD.csv`, shows success/warning notification

---

## Phase 7: Build Verification

- [x] `npm run compile` — zero TypeScript errors
- [x] `npm test` — 463/463 pass (baseline: 453; +10 new tests)
- [x] `npm run package` — VSIX builds: 4.27 MB, 611 files

---

## Impact Summary

| Area | Before (v1.0.83) | Target (v1.0.84) | Change |
|---|---|---|---|
| Attribution Confidence | 20% | ≥74% | +54 pts (hook fix + reset) |
| Proposal Precision | ~24% F1 | ~40% F1 | +16 pts (history boost + glob cap) |
| Cost control hooks | OFF | ON | Enabled in activation |
| "manifest" false attribution | Inflating cost data | Excluded | Denylist |
| Archived skills in profile | 4 dead entries | 0 | Manifest-filtered |
| Agent Performance Index | Not implemented | 0–100 in dashboard | New metric |
| Audit export | Not available | CSV command | New command |
| API Score | 32/100 (estimated) | ≥55/100 (after Reset + hook fix) | +23 pts |
| Test count | 453 | 463 | +10 new tests |
