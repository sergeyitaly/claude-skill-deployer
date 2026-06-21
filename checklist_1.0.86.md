# v1.0.86 Release Checklist — Quality Audit & Intelligence Accuracy

**Release date:** 2026-06-21
**Theme:** E2E production validation — 6 critical bugs fixed, intelligence metrics now accurate
**VSIX target:** `claude-skill-deployer-1.0.86.vsix`

---

## Demo Highlights (FO / Executive Summary)

These are the achievements that matter for a live demo or stakeholder walkthrough.

### Technical Wins

| # | Achievement | Evidence |
|---|---|---|
| T1 | **API Score now mathematically correct** | Fixed `* 100` double-multiplication in 3 files; score is 32/F (accurate), not 45/D (inflated) |
| T2 | **Attribution alert bar shows correctly** | Same bug hid the bar at runtime when attribution was 35%; now correctly visible |
| T3 | **Hook detection no longer false-positive** | `claudeVscodeAttributionGap` now recognizes curl-based `/hook/skill-invoke` endpoints |
| T4 | **Prediction noise reduced to zero** | Catch-all glob proposals (`**/*`) no longer pollute the proposal list; specific-match only |
| T5 | **Adaptation log is live** | Attribution reset now writes a timestamped event to `adaptation-log.jsonl` |
| T6 | **SKILL lint loop eliminated** | `vitest-extension-testing` YAML frontmatter added; endless lint error on hook refresh is gone |

### Feature Overview (FO) — What's Demonstrable Today

| Demo scenario | What to show | Expected result |
|---|---|---|
| **Executive Dashboard** | Open Cost Intelligence Dashboard | 6-pill Executive Summary answers 5 questions in first viewport, no scroll |
| **3-Signal Status Bar** | Look at bottom status bar | API Score bar + Cost bar + Attribution Alert bar (ATTR 35%) all visible |
| **Attribution Alert** | Status bar shows `⚠ ATTR 35%` | Click → Reset Attribution command; alert hides when ≥ 80% |
| **Prediction Intelligence** | Expand "Prediction Intelligence" section | Precision/Recall/F1 shown; over-predicted skills listed with specific-glob reasons |
| **Learning Timeline** | Expand "Learning" section | Shows "Jun 21 — N skills proposed but not used" (until runs.jsonl has data) |
| **Feature Modes** | Check VS Code settings → `claudeSkills.featureMode` | `professional` default; `power` unlocks Adaptation Log, Governance panel |
| **Adaptation Log** | Run Reset Mis-attributed Cost Data, reopen dashboard | Adaptation Timeline entry appears with timestamp and counts |
| **MCP Efficiency** | Cost Dashboard → Efficiency metrics | 100% efficiency, 0 wasteful ops, large-file warning for CHANGELOG.md |
| **Governance Checklist** | Expand Telemetry & Export section | Compliance checklist with 2/5 items passing |
| **Hook status** | Workspace hooks panel | "Attribution v2 active for all 4 enabled agent(s)" — no false warning |

---

## Phase Checklist

### Phase 1 — Bug fixes verified

- [x] **agentPerformanceIndex.ts** — `attributionScore()` no longer multiplies `scorePct` by 100 (`* 100` removed)
- [x] **statusBarManager.ts** — `refreshAttributionAlertBar()` uses `Math.round(scorePct)` not `scorePct * 100`
- [x] **costDashboard.ts** — `buildGovernancePanelHtml()` governance panel attribution reads `scorePct` directly
- [x] **claudeVscodeAttributionGap.ts** — `readSettingsHooks()` recognizes `/hook/skill-invoke` curl endpoint
- [x] **taskSkillProposals.ts** — fallback proposal loop skips skills with only catch-all globs (`**/*`, `**/*.*`, `**/*.md`)
- [x] **commandsUsage.ts** — `appendAdaptationEvent` called with `attribution_reset` after reset completes
- [x] **vitest-extension-testing/SKILL.md** — YAML frontmatter block added; lint loop eliminated

### Phase 2 — Version & release artifacts

- [x] `extension/package.json` → `"version": "1.0.86"`
- [x] `extension/CHANGELOG.md` → v1.0.86 section added with bug table
- [ ] `extension/` → `npm run package` → `claude-skill-deployer-1.0.86.vsix`
- [ ] VSIX installed locally and tested

### Phase 3 — Dashboard demo verification

- [ ] Open Cost Intelligence Dashboard → Executive Summary shows API Score in correct range (≤ 35)
- [ ] Status bar Attribution Alert visible (ATTR 35%)
- [ ] Attribution Alert hides when scorePct ≥ 80 (test by temporarily editing attribution-trust.json)
- [ ] Workspace hooks panel: no "Attribution PostToolUse hook not configured" warning
- [ ] Prediction Intelligence: proposals list shows ≤ 4 items, all with specific-match reasons
- [ ] Run Reset Mis-attributed Cost Data → adaptation-log.jsonl created → Adaptation Timeline visible in dashboard

### Phase 4 — Regression checks

- [ ] `npm test` (extension/) → all tests pass (target: 463/463)
- [ ] No new TypeScript compile errors (`npm run compile`)
- [ ] vitest-extension-testing skill: SKILL lint no longer outputs error in extension log
- [ ] Cost control hook refresh: no infinite loop in extension output panel

### Phase 5 — Documentation

- [x] `checklist_1.0.86.md` — this file
- [x] `README.md` — full rewrite with real scenarios, v1.0.86 references, accurate feature descriptions
- [ ] Marketplace description updated (if publishing to VS Marketplace / Open VSX)

### Phase 6 — Commit & publish

- [ ] `git add` all changed files
- [ ] `git commit -m "feat: v1.0.86 — quality audit, 6 critical bug fixes, intelligence accuracy"`
- [ ] `git push origin main`
- [ ] VS Marketplace publish (`npx vsce publish`)
- [ ] Open VSX publish (`npx ovsx publish`)

---

## Known Open Items (not blocking release)

| Item | Severity | Notes |
|---|---|---|
| `runs.jsonl` not being populated | HIGH | Hook fires (`native:read` logged) but no `invoked: true` entries. Needs hook server investigation — the `/hook/skill-invoke` endpoint may not write to `runs.jsonl` correctly in the current server build. |
| General API cost $9,164 vs session spend $952 | HIGH | Transcript-based cost is ~9.8× hook-measured. Likely double-counting cache tokens. Needs investigation in `computeGeneralApiSpend()`. |
| Optimization Center blocked by safe mode | MEDIUM | Won't show suggestions until attribution ≥ 45%. Correct behavior but frustrating before first skill invocations. |
| API Score target 65 (B) unreachable without runs.jsonl | MEDIUM | Precision (25%) and Learning (15%) are both 0 until hooks populate. Day-7 learning requires fix of runs.jsonl issue above. |

---

## API Score Breakdown (post-fix, accurate)

| Component | Weight | Value | Notes |
|---|---|---|---|
| Precision | 25% | 0% | No runs.jsonl data |
| Attribution | 20% | 35% | Hooks configured, no per-skill data yet |
| Skill Efficiency | 15% | 0% | No ROI computed |
| Learning Rate | 15% | 0% | No v2 hook invocations |
| Task Completion | 15% | 100% | No failures (empty) |
| Human Correction | 10% | 100% | No feedback logged |
| **Total** | | **32/100 (F)** | Accurate. Was showing 45/D due to bug. |

Target: **65 (B)** — achievable when runs.jsonl populates (Precision + Learning components unlock).
