# Claude Skills Manager v1.0.85 Checklist

## Source
v1.1 UX Modernization Initiative (2026-06-21). All items evidence-based from
production readiness audit + codebase analysis. Maturity: Level 3 → Level 4.

---

## Phase 1: Status Bar Redesign (8 bars → 3 signal bars)

### Problem
8 status bars currently registered:
- `statusBarItem` (p100) — shows ✓ even when attribution broken
- `usageStatusBarItem` (p99) — duplicates dashboard; low click-through
- `creditStatusBarItem` (p98) — keep, simplify
- `projectTierStatusBarItem` (p97.25) — no actionable signal
- `workspaceFolderStatusBarItem` (p94) — redundant with VS Code
- `mcpHealthStatusBarItem` (p93) — keep (MCP-specific)
- `mcpKpiStatusBarItem` (p92) — keep (MCP-specific)
- `mcpCliStatusBarItem` (p91.5) — keep (MCP-specific)

### Tasks
- [x] `statusBarManager.ts`: replace `refreshStatusBar` with `refreshApiScoreStatusBar`
  — shows `$(sparkle) API A (84)` / `$(graph) API C (58)` / `$(warning) API F (32)`
  — tooltip shows top issue + one-click fix path
  — click → `showCostDashboard` (score ≥50) or `startOnboarding` (score <50)
- [x] `statusBarManager.ts`: hide `_usageStatusBarItem` and `_projectTierStatusBarItem`
  and `_workspaceFolderStatusBarItem` — info moved to executive summary
- [x] `statusBarManager.ts`: add `refreshAttributionAlertBar` — new conditional bar
  that only shows when attribution < 80%; text `$(warning) ATTR 74%`;
  click → `resetAttribution`
- [x] `statusBarManager.ts`: simplify `refreshCreditStatusBar` — remove token count
  from text (token info moves to tooltip only)
- [x] `extension.ts`: add `attributionStatusBarItem` (p97) to `StatusBarItems` interface
  and creation block; wire `refreshAttributionAlertBar` into pipeline refresh cycle
- [x] `extension.ts`: call `refreshApiScoreStatusBar` instead of `refreshStatusBar`

---

## Phase 2: Executive Summary Panel

### Problem
Dashboard opens to hook config plumbing. No "how am I doing?" answer visible.
New user has to scroll through attribution warnings, agent tables, and cost panels
before seeing anything actionable.

### Tasks
- [x] `costDashboard.ts`: add `buildExecutiveSummaryHtml(target, manifest, pipeline)`
  — 6 metric cards: API Score · Attribution · Prediction · ROI · Cost Today · Top Action
  — each card: value · grade/band · delta label · recommendation
  — Top Action card derives from lowest API sub-score and shows "fix + estimated gain"
- [x] Insert executive summary as very first panel in `buildDashboardMainBodyHtml`
  (before trust banner, before hook panel)

---

## Phase 3: Dashboard `<details>` Sections (9 collapsible sections)

### Problem
One 600-line HTML blob with no navigation. Users cannot skip to Cost or Skills
without scrolling through hook configuration.

### Tasks
- [x] `costDashboard.ts`: wrap all panels into 9 named `<details>` sections:
  1. Executive Summary (open by default, no collapse)
  2. Health (MCP · Hooks · Pipeline · Mode) — open
  3. Learning (runs count · success rate · timeline preview) — open
  4. Skills (active · low-use · unused · archive candidates) — open
  5. Prediction (precision · recall · F1 · per-skill table) — collapsed
  6. Cost (14d spend · ROI · waste · projections) — open
  7. Optimization (ranked action items) — open if items exist
  8. Telemetry (raw logs · exports · reset tools) — collapsed
  9. Advanced (hook config · raw files · diagnostics) — collapsed

---

## Phase 4: Learning Timeline Panel

### Problem
Users cannot see whether learning is working. Skill invocations are invisible
between sessions. Proposal confidence changes are not surfaced.

### Tasks
- [x] Create `extension/src/learningTimeline.ts`:
  - `interface TimelineEvent { date: string; skill: string; type: 'invoked'|'proposed_unused'; cost?: number; sessionId: string; confidenceDelta?: number }`
  - `buildLearningTimeline(target, daysBack): TimelineEvent[]`
    — reads `runs.jsonl` for invocations
    — cross-references `task-skill-proposals.json` (current snapshot) to mark proposed-but-unused
  - `formatLearningTimelineHtml(events): string`
    — grouped by date (newest first)
    — ✓ green for invocations, ⚠ amber for proposed-unused
- [x] Insert Learning Timeline into the Learning `<details>` section in dashboard

---

## Phase 5: Optimization Center Section

### Problem
Optimization suggestions exist (`costOptimizer.ts`) but are buried in a sub-panel
and only show when auto-optimizer is enabled. The ROI matrix data exists but is not
rendered. Archive candidates exist in skill-stats but are not surfaced as actions.

### Tasks
- [x] `costDashboard.ts`: add `buildOptimizationCenterHtml(target, manifest, pipeline)`
  — Top Savings: ranked list of `{ action, impact, effort, confidence, command }`
     sourced from: attribution < 80% → Reset; unused skills → Archive; waste → Cache hints
  — ROI Matrix: 2×2 grid (HIGH/LOW cost × HIGH/LOW value) with skills mapped to quadrants
  — Archive Candidates: skills with rating=unused and 0 runs in last 30 days
  — Each item has: Impact badge · Effort label · one-click [action] button
- [x] Replace old flat "Optimizations" panel with full Optimization Center

---

## Phase 6: Prediction Intelligence Panel

### Problem
Proposal quality (precision/recall/F1) is computed in the audit but never shown
to users. Over-predicted skills (theme-factory: 0% precision) are invisible.
No feedback loop makes recommendation failures visible.

### Tasks
- [x] `costDashboard.ts`: add `buildPredictionIntelligenceHtml(target, manifest)`
  — Header: Precision · Recall · F1 (overall, from current proposals vs runs)
  — Most Accurate table: top 3 skills by (used/proposed) ratio
  — Over-predicted table: skills in proposals with 0 uses (false positives)
  — Under-predicted note: skills used but not proposed (requires snapshot history)
  — Each row: proposed count · used count · precision %
- [x] Insert into Prediction `<details>` section

---

## Phase 7: Feature Modes

### Problem
~20 individual toggles with no progressive disclosure. A new user is overwhelmed
by `claudeSkills.features.communityBenchmarks`, `claudeSkills.context.level`,
`claudeSkills.practicalFocus.enabled`, etc. with no guidance on what matters.

### Tasks
- [x] Create `extension/src/featureMode.ts`:
  - `type FeatureMode = 'starter' | 'professional' | 'power' | 'team'`
  - `getFeatureMode(): FeatureMode` — reads `claudeSkills.featureMode` setting
  - `isFeatureAvailable(feature: string): boolean`
    — feature map: starter gets basic skills+cost; professional adds attribution+prediction;
    power adds everything; team adds team telemetry + governance
- [x] Add `claudeSkills.featureMode` to `package.json` configuration:
  - type: string enum, default: "professional"
  - enum: ["starter", "professional", "power", "team"]
  - markdownDescription with mode descriptions
- [x] Gate Prediction Intelligence panel behind `professional` mode
- [x] Gate Governance section behind `team` mode

---

## Phase 8: Settings Simplification

### Problem
~40 settings with no grouping, no indication of which are beginner vs advanced.
`officialSkillsCheckOnSession` is now always-on (v1.0.84) but still appears as a toggle.

### Tasks
- [x] `package.json`: remove deprecated `claudeSkills.officialSkillsCheckOnSession`
  setting (now always-on via `ensureCostControlHooksActive`)
- [x] `package.json`: add `markdownDescription` to all settings classifying them
  as 🟢 Basic / 🔵 Advanced / 🔬 Experimental where not already present
- [x] `package.json`: group budget, context, and agent settings under descriptive
  titles using `markdownDescription` headers

---

## Phase 9: Command Consolidation (53 → 45 user-facing)

### Problem
Enable/disable command pairs expose internal plumbing as user commands.
`enableMcpForce` + `disableMcpForce` should be one toggle command.
Hook installation commands are now automatic (v1.0.84) but still listed.

### Tasks
- [x] `package.json`: add `claudeSkills.toggleMcpForce` — "Toggle MCP-Force Mode"
  (replaces `enableMcpForce` + `disableMcpForce` in the command palette)
- [x] `package.json`: add `claudeSkills.manageMcpServers` — "Manage MCP Servers"
  quick-pick that handles filesystem + CLI server enable/disable in one flow
- [x] `package.json`: add `claudeSkills.manageEfficiencyGuards` — "Manage Efficiency Guards"
  quick-pick for CLI loop guard + dir cache guard
- [x] `commandsMisc.ts` or new `commandsToggle.ts`: implement the 3 new toggle commands
- [x] Mark 8 replaced commands with `"when": "false"` in `package.json` menus so they
  are hidden from command palette but kept for backward compatibility

---

## Phase 10: Adaptation Log (foundation)

### Problem
No persistent record of when the platform configuration changed (hooks enabled,
skills added, profile switched). Cannot show "before/after" KPI comparison.

### Tasks
- [x] Create `extension/src/adaptationLog.ts`:
  - `interface AdaptationEvent { ts: string; type: string; description: string; beforeSnapshot?: ApiSnapshot; afterSnapshot?: ApiSnapshot }`
  - `interface ApiSnapshot { apiScore: number; attribution: number; skillCount: number }`
  - `appendAdaptationEvent(target, event)` — appends to `.claude/learning/adaptation-log.jsonl`
  - `readAdaptationLog(target): AdaptationEvent[]`
- [x] Call `appendAdaptationEvent` in:
  - `workspaceSkillSync.ts` `ensureAttributionHooksActive` when status === "installed"
  - `workspaceSkillSync.ts` `ensureCostControlHooksActive` when status === "installed"
  - `sessionSkillApply.ts` `processSessionSkillApplyRequest` when applied
- [x] Add Adaptation Timeline to the Learning `<details>` section (basic list of events)

---

## Phase 11: Governance Panel (Power User / Team)

### Problem
No audit view. Compliance checklist, attribution coverage, skill provenance are
undiscoverable. Enterprise users have no way to assess platform governance state.

### Tasks
- [x] `costDashboard.ts`: add `buildGovernancePanelHtml(target)`
  — Audit Coverage: runs.jsonl count + last export date
  — Attribution: confidence + recommendation
  — Retention: runs.jsonl size + mcp-usage.jsonl size + days of data
  — Skill Provenance: count of skills with unknown author
  — Compliance Checklist: 5 items (local telemetry ✓; no prompt content ✓;
    provenance ✗; retention policy ✗; audit schedule ✗)
- [x] Gate behind `power` feature mode (visible in Telemetry section)

---

## Phase 12: Build Verification

- [x] `npm run compile` — zero TypeScript errors
- [x] `npm test` — all tests pass (baseline: 463 from v1.0.84)
- [x] `npm run package` — VSIX builds successfully

---

## Impact Summary

| Area | Before (v1.0.84) | After (v1.0.85) |
|---|---|---|
| Status bars | 8 bars (5 visible at once) | 3 signal bars (API Score · Cost · Attr alert) |
| Dashboard opening | Hook config plumbing | Executive Summary (5-question answer) |
| Dashboard navigation | Scroll-only 1 blob | 9 collapsible sections |
| Learning visibility | Zero | Timeline of invocations + outcomes |
| Prediction quality | Internal metric only | Per-skill precision table in dashboard |
| Optimization | Buried sub-panel | Full center with ROI matrix + one-click actions |
| Feature complexity | 20+ toggles | 4 progressive modes |
| Command palette | 53 commands | ~45 (8 hidden, 3 new toggle commands) |
| Adaptation tracking | Not implemented | adaptation-log.jsonl + event capture |
| Governance | Not implemented | Compliance checklist + coverage metrics |
| 60-second orientation | 0/5 questions answered | 5/5 answered |
