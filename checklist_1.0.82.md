# Claude Skills Manager v1.0.82 Simplification Checklist

## Phase 1: Remove Low-Value Features (Week 1)

### ❌ Remove Entirely
- [x] Delete `src/haceMetrics.ts` — merged into efficiencyMetrics.ts
- [x] Delete `src/weeklyReport.ts` and `weeklyReportBenefits.ts`
- [x] Delete `src/vcsReportDelivery.ts`
- [x] Delete `src/tierBenefitBenchmark.ts`
- [ ] ~~Delete `src/generalApiSpend.ts`~~ — **VERIFIED: used by attributionCollector, attributionQuality, costDashboard — merge logic first before removing**
- [ ] Delete `src/dashboardCache.ts`
- [ ] ~~Delete `src/v2TokenEnrichment.ts`~~ — **KEEP** (used by attributionCollector + costDashboard)
- [ ] ~~Delete `src/v2TokenEnrichment.test.ts`~~ — **KEEP** (paired with above)
- [x] Delete `weeklyReport.test.ts`, `weeklyReportBenefits.test.ts`, `tierBenefitBenchmark.test.ts`
- [ ] Delete `projectProfileDisplay.ts` — move display to projectProfile.ts
- [x] Remove weekly report commands: `configureWeeklyReportEmail`, `sendWeeklyReport`
- [ ] Remove benchmark commands: `estimatePRCost`, `runCostPipeline` (consolidate)

### 🧹 Clean Up Configuration
- [x] Remove `weeklyReport.*` configuration section (12 settings)
- [x] Remove `benchmarks.*` configuration section (4 settings)
- [x] Remove `practicalFocus.enabled` — infer from `contextFocus` presence
- [x] Remove `skillFeedback.taskDrift*` settings — consolidated to single toggle
- [x] Remove `optimizer.*` fine-tuning — only `autoApply` remains

---

## Phase 2: Consolidate Duplicate Logic (Week 2)

### 🔀 Merge HACE into Efficiency
- [x] Move `computeHaceMetrics` logic into `efficiencyMetrics.ts`
- [x] Remove `haceMetrics.ts` export and file
- [x] Update dashboard imports to use consolidated metrics (`mcpStatusBars.ts` updated)
- [ ] Update `efficiencyMetrics.test.ts` with HACE cases

### 🔀 Remove Legacy JS Hooks
- [ ] Verify all hooks work via `hookHandlers.ts` HTTP endpoints
- [ ] Delete `resources/hooks/task-drift-watch.js`
- [ ] Delete `resources/hooks/budget-watch.js`
- [ ] Delete `resources/hooks/prompt-context-watch.js`
- [ ] Delete `resources/hooks/skill-invoke-watch.js` — **REPLACE** with HTTP handler
- [ ] Delete `resources/hooks/official-skills-watch.js`
- [ ] Delete `resources/hooks/profile-init-watch.js`
- [ ] Delete `resources/hooks/branch-sync.js` (unused)
- [ ] Delete `resources/hooks/usageParse.js` (unused)
- [ ] Delete `resources/hooks/hookPlatform.js` (unused)
- [ ] **KEEP** `resources/hooks/terminal-watch.js` — still needed for native terminal logging
- [ ] Remove/update tests that directly test deleted hook files: `focusHooks.test.ts`, `skillInvokeHook.test.ts`

### 🔀 Consolidate Task Learning
- [ ] Merge `taskDriftReproposal.ts` + `taskSkillUnderuse.ts` → `taskScope.ts`
- [ ] Remove `taskSkillFocus.ts` → inline into consolidated module
- [ ] Move shared logic to single file
- [ ] Delete original files and update imports

---

## Phase 3: Simplify Configuration (Week 2-3)

### ⚙️ Core Settings to Keep
```
claudeSkills.
├── revealOutputPanel (boolean)
├── notificationLevel (enum)
├── autoUpdateExtension (boolean)
├── mcpForce.enableOnStartup (boolean)
└── preferLocalSkillOverrides (boolean)
```

### ⚙️ Budget Settings (Keep)
```
claudeSkills.budget.
├── dailyBudgetUsd (number)
├── mode (enum: economy/normal/unlimited)
├── autoDisableHighTier (boolean)
└── cursorUsageImportEnabled (boolean)
```

### ⚙️ Context Settings (Merge)
```
claudeSkills.context.
├── enabled (boolean)
├── level (knowledge/balanced/local-first/strict-local)
└── autoEscalateOnSessionSize (boolean)
```

### ⚙️ Features to Simplify
```
claudeSkills.features.
├── autoOptimizer (boolean) ← replaces all optimizer settings
├── sessionSizeWatch (boolean) ← single toggle
└── mcpOptimization (boolean) ← enable all MCP guards
```

- [ ] Create new `context.ts` consolidating contextFocus + practicalFocus
- [ ] Create simplified `optimizer.ts` with single boolean
- [ ] Create `mcpGuards.ts` consolidating all efficiency hooks
- [ ] Update `extension.ts` to use new consolidated modules

---

## Phase 4: Streamline Telemetry (Week 3)

### 📊 MCP Usage Consolidation
- [ ] Remove `McpUsageSummary` duplication between files
- [ ] Single `mcpTelemetry.ts` for all MCP metrics
- [ ] Remove CLI KPI from dashboard — move to status bar only
- [ ] Remove cross-session index → use simpler in-memory cache

### 📊 Cost Attribution Cleanup
- [ ] Verify `attributionCollector.ts` usage before changes
- [ ] Simplify `costAttribution.ts` to essential calculations
- [ ] Remove `costPredictor.ts` alerts (redundant with budget)

---

## Phase 5: Update Commands & UI (Week 3-4)

### 🖥️ Remove Commands (from package.json)
- [x] Remove `configureWeeklyReportEmail`
- [x] Remove `sendWeeklyReport`
- [x] Remove `estimatePRCost` (was a zombie — no source implementation)
- [x] Remove `cycleBudgetMode` — replaced with settings
- [x] Remove `cycleContextFocusLevel` — replaced with settings
- [x] Remove `cyclePracticalFocusLevel` — replaced with settings

### 🖥️ Simplify Commands
- [ ] Merge cost dashboard commands into single entry
- [ ] Merge optimization commands into single entry
- [ ] Remove per-metric dashboard views → single efficiency panel

### 🖥️ Status Bar Cleanup
- [x] Remove trust status bar (low value)
- [x] Remove budget mode status bar (settings panel sufficient)
- [x] Remove context/practical focus bars (merged)
- [ ] Keep: usage, skills count, MCP health

---

## Phase 6: Testing & Validation (Week 4)

### ✅ Verification Tasks
- [ ] Run full test suite: `npm run test`
- [ ] Test skill installation workflow
- [ ] Test budget limit enforcement
- [ ] Test MCP server management
- [ ] Test hook endpoints via HTTP
- [ ] Test task skill focus

### 📦 Build Verification
- [x] `npm run compile` — no TypeScript errors
- [ ] `npm run package` — VSIX builds successfully
- [ ] Manual smoke test in VS Code

---

## Impact Assessment

### Code Reduction
| Area | Before | After | Saved |
|------|--------|-------|-------|
| TypeScript files | 221 | ~150 | 71 files |
| JS hook files | 9 | 1 | 8 files |
| Config settings | ~160 | ~45 | 115 settings |
| Lines of code | ~15,000 | ~9,500 | 5,500 LOC |

### User Impact
- **Breaking**: Weekly report users (migrate to external tool)
- **Breaking**: Advanced optimizer tweakers (simplified)
- **Improved**: Simpler configuration UI
- **Improved**: Faster extension activation
- **Improved**: Clearer feature boundaries

### Migration Notes
- `haceMetrics.ts` → `efficiencyMetrics.ts` (consolidated)
- Weekly reports → removed (export CSV from dashboard instead)
- JS hooks → HTTP-based handlers (transparent to users)
- `terminal-watch.js` → **KEPT** (native terminal logging required)
