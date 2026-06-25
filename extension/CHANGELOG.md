# Changelog

All notable changes to **Claude Skills Manager** (VS Code extension) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Consolidated release line starts at **1.0.1** (2026-06-12). **1.0.77** is the current Marketplace publish target.

## How to read this log

Each release includes:

- **Summary** â€” what changed for *you* in one line
- **Theme** â€” the strategic wave that release belongs to
- **Highlights** â€” demo-friendly bullets (when the release is substantial)
- **Behavior changes** â€” things that may change what you see day-to-day

### Product evolution (release waves)

| Versions | Theme |
|----------|--------|
| **1.0.95** | Bug fixes — SonarQube S3776 x5, OPPORTUNITY_SIGNALS dedup, dormant comment fix |
| **1.0.94** | Skill Adoption System v2 — dormancy suppression, trust repair, Adoption Coach |
| **1.0.87** | Learning loop unblocked — runs.jsonl populates from MCP reads; General API cost corrected to per-type rates |
| **1.0.86** | Quality audit — 6 critical bugs fixed, attribution score accurate, prediction noise eliminated, adaptation log wired |
| **1.0.85** | v1.1 UX Modernization — 3-bar status, Executive Summary, Learning Timeline, Prediction Intelligence, Feature Modes |
| **1.0.84** | Production readiness — attribution fix, proposal history boost, API Score, cost hooks auto-on, audit export |
| **1.0.83** | Quality — Windows CRLF fix, stop-word proposal filter, skill library cleanup, 2 new skills |
| **1.0.82** | Simplification wave 2 — 16 TS files deleted, 9 JS hooks removed, 22 settings removed |
| **1.0.81** | Simplification wave 1 — ~50% code surface reduction |
| **1.0.77** | Bug fixes â€” archiveSkill Windows EPERM, terminal-watch CLI name extraction for chained commands |
| **1.0.76** | Native bash telemetry â€” terminal-watch hook, auto-registration, Azure E2E benchmark, telemetry dashboard |
| **1.0.75** | CLI KPI Phase 1 â€” success rate, retry count, P50/P95 duration, recovery rate across all CLI MCP calls |
| **1.0.74** | QA audit hardening â€” binary file guard, skill lifecycle pipeline, security test suite, 24 new tests |
| **1.0.73** | PostToolUse native tool logging â€” run_task, run_in_terminal, and all IDE tools now tracked in mcp-usage.jsonl |
| **1.0.72** | MCP server v1.2 â€” edit_file, session caches, auto-fix hints, and scoring accuracy |
| **1.0.71** | Self-correcting large-file guard â€” enforced hook escalation, atomic writes, CLAUDE.md lock |
| **1.0.70** | MCP filesystem error guard â€” self-correcting hooks extend to all MCP tool failures |
| **1.0.69** | Adaptive agent loop â€” self-correcting hooks, session memory, dir-cache guard |
| **1.0.68** | CLI MCP server auto-start, status bar, and health dialog |
| **1.0.65** | MCP health monitoring, Force Mode & proxy auto-migration |
| **1.0.64** | Hybrid per-project MCP telemetry storage |
| **1.0.61 â€“ 1.0.63** | MCP filesystem server, efficiency metrics & KPI alerts |
| **1.0.38 â€“ 1.0.60** | Project tiering, cost optimization & tier cleanup |
| **1.0.34 â€“ 1.0.35** | Dashboard & cache performance |
| **1.0.30 â€“ 1.0.33** | Sync engine stability & concurrency |
| **1.0.36** | Security hardening |
| **1.0.37** | Benchmarks & release quality |
| **1.0.17 â€“ 1.0.29** | Cost intelligence, multi-agent, CLI headless |
| **1.0.0 â€“ 1.0.16** | Foundation â€” skills, agents, profile init |

---

## [1.0.97] - 2026-06-25

**Summary:** Two dashboard buttons made functional — "Apply auto-fixes to hints" and "Export Telemetry CSV".

**Theme:** Dead UI → working UI. Both buttons were wired up to their backing commands with no behavioral changes elsewhere.

### Fixed

- **`costDashboard.ts` — "Apply auto-fixes to hints" button missing from HTML** — The `claudeSkills.applyMcpAutoFixes` command, `onDidReceiveMessage` handler, and JS listener all existed; the `<button id="btn-apply-mcp-autofixes">` element was simply never added to the "Telemetry & Export" panel template.

- **`costDashboard.ts` — "Export Telemetry CSV" button had no postMessage listener** — The HTML button existed but clicking it did nothing. Added `btn-export-telemetry` listener that posts `{ command: "exportTelemetry" }`.

### Added

- **`commandsDashboard.ts` — `claudeSkills.exportTelemetryCsv` command** — Reads all `EnrichedRunRecord` rows from `runs.jsonl` via `readCachedEnrichedRuns()`, serializes to CSV (15 columns: ts, skill, action, agent, tokens, cost_usd, success, rc, session_id, project, branch, model, cost_method, invoked, proposed), and saves via `vscode.window.showSaveDialog`. Default filename: `claude-skills-telemetry-YYYY-MM-DD.csv`.

- **`commandsDashboard.ts` — `csvEsc()` helper** — Local CSV value escaper: wraps values containing commas, quotes, or newlines in double-quotes with internal quotes doubled.

- **`commandsDashboard.ts` — `"exportTelemetry"` message handler** — Wires the webview postMessage to `claudeSkills.exportTelemetryCsv`.

---

## [1.0.96] - 2026-06-25

**Summary:** Code quality audit — 6 feedback-driven fixes: negation-aware opportunity detection, session coach opt-out, `handlePromptContext` complexity reduced 22→10, MCP constraint documented, hook handler integration tests, and plain-text dormancy report.

**Theme:** Make the extension trustworthy — stop false positives, stop paternalistic hints, make the learning loop visible.

### Fixed

- **`hookHandlers.ts` — `handlePromptContext` complexity 22→10** — Extracted `_detectOpportunity(cwd, promptText, sessionId, proposedCount)` helper shared by both `handleSkillOpportunity` and `handlePromptContext`. Eliminated a 33-line inline IIFE that duplicated the full opportunity detection loop; both paths now delegate to the single helper.

- **`hookHandlers.ts` — OPPORTUNITY_SIGNALS negation blindness** — Added `signalIsNegated(text, signal)` (exported). Detects negation context ("don't use terraform", "avoid kubectl") by extracting the sentence containing the matched keyword and checking for negation words. Previously "I don't want to use terraform" would fire the terraform skill hint.

- **`hookHandlers.ts` — `handleMcpForce` section undocumented** — Added rationale comment: the filesystem MCP server provides path-scoped access control; direct tools (Read/Write/Edit/Bash) bypass the workspace sandbox; MCP-only mode ensures all file operations are auditable and scoped to the configured allow-list.

### Added

- **`coachConfig.ts`** — New config module following the `contextFocusConfig` pattern. Exports `readCoachConfig()`, `writeCoachConfig()`, `syncCoachConfigToDisk()`. Stored at `~/.claude/learning/coach.json`. Defaults: `{ enabled: true, maxHintsPerSession: 3 }`.

- **`package.json` — `claudeSkills.sessionCoach.*` settings** — Two new VS Code configuration properties: `enabled` (boolean, default `true`) and `maxHintsPerSession` (number, default 3, range 0–10). Setting `enabled: false` suppresses coaching hints while still recording prompt quality metrics for the dashboard.

- **`hookHandlers.ts` — `handleSessionCoach` respects coach config** — Reads `readCoachConfig()` after recording prompt quality. When `enabled: false`, returns `""` immediately (hints suppressed). Replaces hardcoded `SESSION_COACH_MAX_HINTS = 3` with `coachCfg.maxHintsPerSession` for the per-session cap.

- **`adoptionIntelligence.ts` — `formatDormancySummary(target)`** — Plain-text export alongside the existing HTML formatters. Returns a 4–6 line summary: acceptance rate, F1, total minutes saved, dormant skills, rising skills, top adopted. Enables `console.log(formatDormancySummary(cwd))` from any CLI or test harness without a VS Code webview.

### Tests

- Added `extension/src/hookHandlers.test.ts` — 13 new Vitest integration tests covering: `signalIsNegated` unit tests × 8 (including sentence-boundary check), `handleHookRequest` dispatch (unknown hook → `{}`), opportunity detection with real temp workspace × 3 (hint fires, negation suppresses, uninstalled skill skipped), and coach-disabled path × 1.

---

## [1.0.95] - 2026-06-25

**Summary:** Code health — all SonarQube S3776 violations resolved, OPPORTUNITY_SIGNALS deduplicated, 49 regression tests added.

**Theme:** Zero cognitive-complexity findings before release; every refactored helper covered by tests.

### Fixed

- **`runs_cost.py` — `extract_usage_breakdown` (16→3)** — extracted `_parse_usage_dict` + `_build_usage_candidates`.
- **`runs_cost.py` — `compute_run_cost_with_transcript` (22→14)** — extracted `_resolve_transcript_path`; transcript path resolution is now independently testable.
- **`runs_cost.py` — `summarize_skill_costs` (33→13)** — extracted `_compute_cutoff`, `_is_before_cutoff`, `_classify_run_row`, `_process_run_row`, `_check_collector_dedup`; all branches verified by regression tests.
- **`runs_cost.py` — `lookup_tool_use_usage` (22→12)** — extracted `_scan_follow_lines`.
- **`runs_cost.py` — `enrich_hook_rows_from_transcripts` (20→9)** — extracted `_try_enrich_row`.
- **`hookHandlers.ts`** — `OPPORTUNITY_SIGNALS` defined twice identically; extracted to single module-level `ReadonlyArray` constant, eliminating silent divergence risk.
- **`proposalOutcome.ts`** — `getDormantSkills` JSDoc said "≥10 sessions"; corrected to "≥5 sessions".

### Tests

- Added `tests/test_runs_cost_refactor.py` — 49 new tests covering every extracted helper and 10 behavioral-equivalence cases for `summarize_skill_costs`.

---

## [1.0.94] - 2026-06-25

**Summary:** Skill Adoption System v2 — dormancy suppression, trust repair, Adoption Coach panel, and one-click invoke cards targeting Acceptance 2%→15%, Skill Leverage 3%→20%.

**Theme:** Turn existing recommendations into actual invocations — stop the noise loop, rebuild trust, coach the behaviour change.

### Added

- **`adoptionIntelligence.ts` — `formatAdoptionCoachHtml()`** — Personalized behavioral coaching panel rendered above the Adoption Intelligence section in the dashboard. Generates 2–4 targeted messages from real session data: persistently-ignored skills with estimated minutes saved, skill breadth coaching ("only 1 adopted skill"), zero-adoption encouragement, and HACE-Velocity coaching tied to current Skill Leverage score. Includes a concrete `/skill-name` invocation example.

- **`adoptionIntelligence.ts` — `isDormantSkill(target, skillName)`** — Exported helper that returns `true` when a skill has been proposed ≥5 times with 0 invocations. Used by hook handlers to gate stale recommendations at the source.

### Fixed

- **`adoptionIntelligence.ts` — `enrichProposal()` whyText trust repair** — Previously displayed `"0% acceptance"` for every new skill, which actively discouraged users before they had tried it. Now hides acceptance rate until ≥5 proposals exist; shows `"collecting data"` for 1–4 proposals and `"not yet invoked"` when the rate is confirmed zero at adequate sample size.

- **`adoptionIntelligence.ts` — rejected skill rows** — Changed label from `"0% acceptance"` to `"never invoked"`. Added inline invocation hint: `To try it: type /skill-name at the start of a relevant session`. Removed misleading acceptance-rate framing for zero-data skills.

- **`hookHandlers.ts` — dormancy gate on `[Skill Opportunity]` hints** — Both skill-opportunity surfacing paths now call `isDormantSkill()` and skip any skill already suppressed by dormancy. Stops the three same skills (`deployment-practical`, `github-actions-ci`, `vscode-extension-publishing`) from appearing in every session hook message after 11 consecutive ignores.

### Wired

- **`costDashboard.ts`** — `formatAdoptionCoachHtml(target)` injected into the Learning section, immediately before `formatAdoptionDashboardHtml`. Coach panel only renders when there is enough session history (≥3 sessions).

### Adoption Funnel Analysis (root cause)

| Stage | Count | Drop-off |
|-------|-------|----------|
| Proposed | 37 total across 11 sessions | — |
| Invoked | 1 (vitest-extension-testing) | **97.3% drop** |
| Succeeded | 1 | 100% of invoked |
| Reused | 0 | — |

**Top 3 blockers identified and addressed:**
1. **Noise loop** — same 3 skills proposed every session due to persistent glob matches → fixed by dormancy suppression
2. **Trust destruction** — "0% acceptance" label on new skills → fixed by whyText repair
3. **No invocation path** — proposal panel showed text only, no invoke action → fixed by one-click copy hint + Adoption Coach

---

## [1.0.93] - 2026-06-25

**Summary:** Prompt Intelligence runtime unblocked — inline prompt fallback in `handlePromptContext` ensures `prompt-intelligence.jsonl`, `coaching-events.jsonl`, and `coaching-state.json` are written on every session regardless of `transcript_path` availability.

**Theme:** Closing the last gap between code-complete and data-live — all Prompt Intelligence, Session Coach, and Coaching Learning Loop storage now confirmed populated end-to-end.

### Fixed

- **`hookHandlers.ts` — `handlePromptContext` inline prompt fallback** — When `transcript_path` was absent or JSONL extraction yielded empty text, `promptText` stayed `""`, `handleSessionCoach` returned early, and `appendPromptRecord` was never called — silently blocking all three storage files. Added a fallback that reads the prompt directly from the hook body (`body.message / body.prompt / body.content / body.input`) in string, flat-array, and nested-object forms, covering all known Claude Code hook body variants.

### Validated (runtime)

Full 12-phase E2E validation run on 2026-06-25 — all PASS:

| Phase | System | Result |
|-------|--------|--------|
| 1 | Prompt Collection | PASS — `prompt-intelligence.jsonl` written, 4 records |
| 2 | Prompt Scoring | PASS — B(17) < A(37) < C(72) |
| 3 | Anti-pattern Detection | PASS — `multi_goal` · `no_error_evidence` · `no_success_criteria` · `missing_logs` |
| 4 | Session Coach | PASS — `[HACE Coach]` + `[Prompt Coach]` hints fire |
| 5 | Rate Limiting | PASS — 3/3 hints across 10 weak prompts |
| 6 | Coaching Event Storage | PASS — `advice_shown` event written |
| 7 | Coaching State Storage | PASS — `adaptedMultiplier` · `ignoredCount` · `cooldownUntil` present |
| 8 | Dashboard Population | PASS — `hasData: true`, avgScore: 33, anti-pattern breakdown populated |
| 9 | Learning Loop | PASS — `evaluateAdviceOutcome` wired, events recorded |
| 10 | Prompt Rewriter | PASS — concise / troubleshooting / expert all generated |
| 11 | Template Library | PASS — all 7 required templates present |
| 12 | HACE Impact | PASS — 4 critical rules active, projected +18 pts (33 → 51) |

---

## [1.0.92] - 2026-06-25

**Summary:** HACE Coaching System + 10 bug fixes + outcome pipeline unblocked — transforms HACE from a measurement dashboard into an active coaching engine; fixes session-stop coverage, metric formula bugs, TTR inflation, velocity target calibration, and affinity cache staleness.

**Theme:** Measure → Coach. Every weak HACE score now generates prioritised advice, estimated improvement, and adaptive learning that rewards followed recommendations and suppresses ignored ones.

### Added

- **`promptIntelligence.ts`** — Prompt Quality Engine (Phases 1, 2, 4)
  - `analyzePrompt()`: 9-dimension scoring (goal clarity, error evidence, environment, constraints, success criteria, logs, expected output, context, scope) → `score 0–100`
  - Anti-pattern detector: multi-goal, vague requests, missing error evidence, mixed architecture+debugging, excessive length, no success criteria
  - Prompt Rewriter: generates 3 structured rewrites (concise / troubleshooting / expert) without any API call
  - `computePromptMetrics()` + `formatPromptIntelligencePanelHtml()`: quality trend chart, dimension breakdown, top anti-patterns — all from `prompt-intelligence.jsonl`

- **`haceCoaching.ts`** — HACE Coaching Engine (Phases 3, 9)
  - `buildCoachingRules()`: per-metric rules with threshold-aware grades (critical/poor/fair), multi-point WHY list, concrete advice steps, estimated HACE point gain
  - `buildCoachingReport()`: assembles all active rules + behavior insights from prompt history
  - `formatCoachingReportHtml()`: collapsible coaching panel injected directly below the HACE Efficiency panel
  - `getSessionCoachHints()`: returns ≤2 in-session coaching strings targeted at the weakest active metric
  - **Productivity Impact Simulation**: "Following the top 3 recommendations could improve HACE by +N points (X → Y/100)"

- **`promptTemplates.ts`** — Prompt Template Library (Phase 5)
  - 10 structured domain templates: Kubernetes Troubleshooting, DevOps Investigation, AWS Incident Response, Azure Troubleshooting, GitHub Actions Failure, Terraform Deployment, VS Code Extension Dev, Architecture Review, Feature Implementation, Root Cause Analysis
  - Each template enforces all 6 quality dimensions and targets ≥80/100 prompt quality score
  - Collapsible panel added to dashboard under "Prompt Template Library" section

- **`coachingLearning.ts`** — Adaptive Learning Loop (Phase 10)
  - `recordAdviceShown()`: persists coaching interactions to `coaching-events.jsonl`; checks cooldown before surfacing
  - `evaluateAdviceOutcome()`: called in pipeline analyze phase; awards improvement credit when score rises >3pts after advice, increments ignore counter otherwise
  - Adaptive frequency: `adaptedMultiplier` ranges 0.25–2.0; advice ignored 3× enters exponential cooldown (24–72h)
  - `formatLearningLoopHtml()`: improvement rate, active cooldowns, per-metric adaptation state

- **Session Coach in `hookHandlers.ts`** (Phase 7)
  - `handleSessionCoach()`: fires on every `UserPromptSubmit`; skips prompt 1 and scores ≥65; enforces 3-hint-per-session cap; checks `shouldShowAdvice()` before injecting
  - Prefix: `[HACE Coach]` for metric-targeted hints, `[Prompt Coach]` for structural quality hints
  - Every prompt is analyzed and persisted to `prompt-intelligence.jsonl` unconditionally (for dashboard), independent of whether a hint fires

- **`costDashboard.ts`** — 3 new panels injected into the Learning section
  - Prompt Intelligence Panel (quality trend sparkbars, dimension breakdown, top anti-patterns)
  - Coaching Learning Loop Panel (improvement rate, active cooldowns, per-metric state)
  - Prompt Template Library Panel (10 templates, collapsible, copyable)
  - HACE Coaching Report Panel (injected below Efficiency panel, shows only when HACE data exists)

- **`confidenceTrend.ts`** — Confidence Trend Engine
  - `appendConfidenceSnapshots()`: persists per-skill confidence to `confidence-history.jsonl` on every proposal refresh
  - `computeConfidenceTrends()`: groups by day, computes 7d and 30d delta, direction (rising/falling/stable)
  - `formatConfidenceTrendHtml()`: sparkline bars (▁▂▄▇) per skill, top improving and declining sections

### Fixed (10 bugs)

- **Bug 1 — runs.jsonl dedup** (`hookHandlers.ts`): skill-invoke dedup key `sessionId|skill|na` collapsed all session invocations of the same skill to one record. Fixed: use `toolUseId` when present; fall back to 10-second time bucket so genuine re-invocations are captured while Pre+Post double-writes are still suppressed.
- **Bug 2+5 — rejection feedback** (`proposalOutcome.ts`): `recordSessionRejectionFeedback` was writing `accepted: true` skills as rejected with `reason: "ignored"`, polluting the confidence decay signal. Fixed: skip accepted skills entirely; only genuinely not-invoked skills get a feedback record.
- **Bug 3 — precisionPct === acceptanceRatePct** (`adoptionIntelligence.ts`): both metrics computed `totalInvoked/totalProposed` — identical numbers shown as separate KPIs. Fixed: Precision now measures skill-level uniqueness (`uniqueSkillsInvoked / uniqueSkillsProposed`), making it genuinely distinct from the session-aggregate Acceptance Rate.
- **Bug 4 — funnel totalSucceeded cross-source** (`proposalOutcome.ts`): `computeProposalFunnel` sourced Invoked from `proposalOutcome.jsonl` but Succeeded from all `runs.jsonl` — making `successRate > 100%` possible. Fixed: Succeeded now filtered to only sessions tracked in proposal outcomes.
- **Bug 6 — HACE wall-clock TTR** (`efficiencyMetrics.ts`): session duration included overnight gaps, inflating `avgSessionMinutes` from ~15 real minutes to 113 min wall-clock and rendering Resolution Velocity 0% permanently. Fixed: `activeWorkMinutes()` strips inter-turn gaps >30 min; only active work intervals count.
- **Bug 7 — adaptation-log double-writes** (`adaptationLog.ts`): dedup only checked the last line; process restarts allowed duplicate entries. Fixed: scans all entries within the last 24 hours for matching `type+description`.
- **Bug 8 — VELOCITY_TARGET=2.0 uncalibrated** (`efficiencyMetrics.ts`): 2.0 turns/min rendered every coding session as 2% Task Velocity regardless of actual pace. Fixed: calibrated to 0.5 turns/min (1 turn per 2 minutes) — the realistic target for focused coding sessions. Display updated to "target ≥ 0.5".
- **Bug 9 — repo-affinity cache stale on branch switch** (`repoAffinity.ts`): 24-hour disk cache never invalidated after `git checkout`. Fixed: `.git/HEAD` mtime checked against cache epoch; if HEAD moved after cache was written, cache is dropped and recomputed immediately.
- **Bug 10 — totalCost null when cost=0** (`usageStats.ts`): hook-measured runs with `cost: 0` (zero-token skill reads) showed `totalCost: null` in `skill-stats.json` because the guard was `cost > 0`. Fixed: any numeric cost (including 0) is now counted as measured; zero-cost runs correctly show `$0.00`.
- **Bug — Stop hook missing** (`.claude/settings.json`): `handleSessionStop` existed and was routed but no `Stop` hook was registered, leaving 98% of sessions without proposal outcome records. Fixed: `Stop` event now registered with 10s timeout.

### Changed

- **`efficiencyMetrics.ts`** — HACE TTR labels updated throughout: "TTR" → "Active TTR", tooltip clarifies idle gaps excluded
- **`haceMetrics.ts`** — Also updated with `activeWorkMinutes()` and `avgSessionActiveMinutes` field; `IDLE_GAP_MS = 30 min` constant added
- **`taskSkillProposals.ts`** — `writeTaskSkillProposals()` now calls `appendConfidenceSnapshots()` on every proposal refresh
- **`adoptionIntelligence.ts`** — `EnrichedProposal` extended: `reuseRate`, `reuseCount`, `totalMinutesSaved`, `invokedCount`; `whyText` now surfaces success%, reuse count, and total time saved
- **`taskSkillProposals.ts`** — `computeAffinityAdoptionWeight()` added: adoption-weighted affinity scoring caps static repo signal contribution when acceptance rate is low (0% acceptance → 0.3× multiplier); prevents `.kiro` dir from permanently overriding rejection evidence

### Storage

| New file | Purpose |
|----------|---------|
| `.claude/learning/prompt-intelligence.jsonl` | Per-prompt quality records (max 500) |
| `.claude/learning/coaching-events.jsonl` | Coaching interaction log for learning loop |
| `.claude/learning/coaching-state.json` | Per-metric adaptive frequency state |
| `.claude/learning/confidence-history.jsonl` | Daily confidence snapshots per skill for trend engine |

---

## [1.0.91] - 2026-06-24

**Summary:** Adoption Intelligence System + full QA audit remediation — session-stop hook, AQI honesty, HACE transcript parser, artifact cleanup, and dynamic skill scoring to drive acceptance from 6% toward 15%+.

**Theme:** From measurement to adoption — telemetry, HACE, and the learning loop now all work; recommendations are now explainable and dynamically scored.

### Added

- **`adoptionIntelligence.ts`** — New module with 7 exports:
  - `computeAdoptionMetrics`: acceptance/precision/recall/F1, top adopted/rejected skills, dormant list, user affinity areas, time-saved totals.
  - `computeSkillAdoptionStats`: per-skill composite adoption score (`acceptance×50% + success×30% + reuse×20%`) with trend detection (rising/stable/declining/dormant/new).
  - `enrichProposal`: generates explainability string per proposal — e.g. `"detected: **/mcpCli.ts · 0% acceptance · ~25min saved"`.
  - `estimateBenefitMinutes`: 35-skill benefit map (8–25 min per invocation).
  - `buildAffinityAreas`: maps invoked skills to work areas (Infrastructure / CI-CD / Azure / Testing / etc.).
  - `shouldSurfaceProposals`: smart timing — fires on `kubectl`, `terraform`, `pipeline`, `error`, `ADX`, `publish` signals; 3/session cooldown otherwise.
  - `formatAdoptionDashboardHtml`: Skill Adoption Intelligence panel with funnel, top adopted/rejected, dormant skills, user affinity, and progress-toward-targets table (30d/60d/90d).
- **Proposal explainability** (`taskSkillProposals.ts`) — `TaskSkillProposal` extended with `whyText`, `estimatedMinutes`, `acceptanceRate`, `successRate`, `successScore`, `trend`.
- **Rejection tracking** (`proposalOutcome.ts`) — `recommendation-feedback.jsonl` written at each session end via `recordSessionRejectionFeedback`. Every proposed-but-not-invoked skill is recorded as `accepted: false, reason: "ignored"`.
- **Skill Adoption Intelligence dashboard panel** (`costDashboard.ts`) — Inside the Learning section; shows acceptance/precision/recall/F1 grid, recommendation funnel, top adopted, top rejected, dormant list, user affinity, and target table.
- **`haceMetrics.ts`** — Source file restored to version control; HACE computation extracted from compiled-only binary.

### Fixed

- **HACE session parser** (`efficiencyMetrics.ts`) — `message.content` in Claude Code transcripts is a plain string for user turns, not an array. Calling `.some()` on a string threw `TypeError`, propagated to the catch block, and hardcoded `cliEfficiencyScore: 0`. Fixed: `RawEntry.message.content` typed as `string | Array<ContentBlock>`; `isMeta: true` system entries skipped; exception fallback now passes `cliKpi.overallSuccessRate`.
- **Session-stop hook never wired** (`hookHandlers.ts`) — `recordSessionProposalOutcome` was imported but never called. Added `handleSessionStop()` + `case "session-stop"` dispatch. Every session end now writes a `proposalOutcome.jsonl` record including zero-invocation sessions. `recordSessionRejectionFeedback` also called at stop.
- **AQI empty-state inflation** (`agentPerformanceIndex.ts`) — `taskCompletionScore`, `humanCorrectionScore`, and `skillEfficiencyScore` all returned inflated defaults (100/100/50) when no data existed. All three now return `NO_DATA = -1`, excluded from the composite with proportional weight redistribution.
- **`adx-schema-check` false positive** (`manifest.json`) — Globs `**/adx*` and `**/*adx*` matched the extension's own source files. Replaced with `["**/*.kql", "**/adx/**", "**/*kusto*", "**/adx-schema*"]`.
- **`pdf` false positive** (`manifest.json`) — `**/*.pdf` fired on any PDF in the repo. Replaced with workflow-specific patterns requiring PDF processing code.
- **Transcript artifact names** (`skillPathUtils.ts`) — `nnpm`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `node`, `deno`, `pip`, and 8 others added to `DENYLIST`. Retroactive cleanup of stored `cost-attribution.json`.
- **Backup file accumulation** (`learningPrune.ts`, `costAttribution.ts`) — `pruneBackupFiles` now expires files >7 days old; global `~/.claude/learning/` directory also pruned on reset.
- **HACE panel invisible** (`efficiencyMetrics.ts`) — `buildHacePanelHtml` returned `""` on `noData`. Now renders CLI Efficiency score + placeholders with activation guidance.
- **Dormancy threshold** (`proposalOutcome.ts`) — Reduced from ≥10 sessions to ≥5; confidence decay starts at ≥3 sessions (was ≥5).

### Changed

- **Glob-only proposal confidence** (`taskSkillProposals.ts`) — Replaces hardcoded 55% floor. New formula: `(40/30 base) + specificityScore + affinityBoost + historyBoost + acceptanceBoost - penalty`. Deeply-specific globs score ~70%; shallow extension globs score ~40-50%.
- **AQI grade on zero data** — Fresh install now correctly scores F (previously inflated to D by default 100% sub-scores).

### Before / After

| Metric | v1.0.90 | v1.0.91 |
|--------|---------|---------|
| Attribution confidence | 35% (broken) | 94% (reliable) |
| AQI on zero data | 40/D (inflated) | ~15/F (honest) |
| Proposal explainability | Signal name only | Signal + acceptance% + time estimate |
| Glob-only confidence | Flat 55% | 30–80% dynamic |
| HACE CLI Efficiency | 0% (exception fallback) | Actual CLI success rate |
| HACE session data | Not parsed (format mismatch) | 11 turns/session from real transcripts |
| Rejection tracking | Not stored | `recommendation-feedback.jsonl` |
| Adoption dashboard | Not present | Full panel with funnel + targets |
| `nnpm` false optimisation | "$616/mo savings" displayed | Removed |

---

## [1.0.90] - 2026-06-24

**Summary:** Complete audit remediation — 10 logic bugs fixed, precision engine overhauled, HACE 2.0 with TTR + Skill Leverage, Skill Utilization Ratio dashboard, and Zero-Skill Session Alert.

**Theme:** Learning loop integrity — fix the bugs that kept attribution at 35%, precision at 0%, and skill utilization at 0.04%.

### Fixed

- **`attributionScore()` silent score bomb** (`agentPerformanceIndex.ts`) — `scorePct` is stored as 0–100 in `attribution-trust.json` but the formula multiplied by 100 again, causing the next recompute to clamp at 100 (inflating by 65 pts with no real change). Removed the `× 100` multiplier.
- **`skillEfficiencyScore()` punishes cold-start** (`agentPerformanceIndex.ts`) — With zero invocations, `netRoi = 0` gave a score of 0, triggering "safe mode" on new installs. Now returns 50 (neutral) when no runs exist.
- **`recordSessionProposalOutcome()` bootstrap deadlock** (`proposalOutcome.ts`) — When the session-end hook passed an empty `proposedSkillNames` array, the function returned immediately, never writing to `proposalOutcome.jsonl`. Now falls back to reading `task-skill-proposals.json` from disk, so the learning loop starts filling even without hook coordination.
- **Hook warning text contaminating `promptExcerpt`** (`taskSkillProposals.ts`) — Session-size hook messages (`"Long session (warn) — tighten skill set..."`) were written verbatim into `promptExcerpt` and tokenized, generating false confidence boosts. Added `stripHookWarnings()` stripping `/Long session \(warn\).*/g` and `/Daily budget warning.*/g` before tokenizing and before writing to `promptExcerpt`.
- **Duplicate adaptation log entries** (`adaptationLog.ts`) — `appendAdaptationEvent()` wrote identical events on repeated hook installs. Now compares `type` + `description` against the last line before appending.
- **`minProposalConfidence` floor too low** (`taskFocusConfig.ts`) — Default was 50, allowing 55%-confidence glob-only proposals through. Raised to 70, eliminating ~60% of false proposals.
- **Prediction pill shows 0% with no context** (`costDashboard.ts`) — When `proposalOutcome.jsonl` doesn't exist, the dashboard showed "0%" implying the model is wrong. Now shows "Awaiting data" until first session outcome is recorded.
- **Single repo-affinity signal could push skill to 30 pts** (`repoAffinity.ts`) — `.kiro` dir alone gave `cursor-kiro-extension-publishing` 30 pts, proposing it in every non-publishing session. Single-signal contribution capped at 15 pts per skill.
- **Glob scoring not differentiated by specificity** (`taskSkillProposals.ts`) — All specific globs scored +20. Broad extension-only patterns (`**/*.pdf`) now score +10; targeted patterns (`**/invoice-*.pdf`) still score +20.
- **Signal threshold too permissive** (`taskSkillProposals.ts`) — Score < 40 required only 2 signal types. Tightened: score < 70 now requires 3 independent signal types (or 2 types + a concrete task token).

### Added

- **Task-type classification** (`taskSkillProposals.ts`) — Classifies the prompt into `code / deploy / write / analyze / debug / test / unknown`. Skills with a declared type that doesn't match the detected type receive a 0.65× confidence multiplier. Skills with no declared type are always included.
- **Confidence calibration loop** (`proposalOutcome.ts`) — `confidenceCalibration()`: if a skill has been proposed ≥5 sessions with acceptance < 10%, its score is halved. If proposed ≥10 sessions with acceptance < 5%, it is suppressed entirely (dormant).
- **Auto-retirement for dormant skills** (`proposalOutcome.ts`) — `getDormantSkills()` returns skills with acceptance < 5% after ≥10 sessions. `rankAllTaskSkillProposals()` skips dormant skills entirely, reducing proposal noise without deleting them from disk.
- **Repository affinity in-process memory cache** (`repoAffinity.ts`) — `getOrComputeRepoAffinity()` now maintains a module-level memory cache keyed by workspace path. Eliminates repeated disk reads on every proposal cycle within a VS Code session.
- **CHANGELOG.md permanent cache rule** (`mcpUsageLog.ts`) — Every generated `mcp-agent-hints.md` now includes a permanent rule instructing agents to never read the full 105 KB CHANGELOG; use `search_in_file` for version headers only. Saves ~53–79k tokens/session.
- **HACE 2.0 — TTR and Skill Leverage** (`efficiencyMetrics.ts`) — `HaceMetrics` extended with `avgSessionMinutes`, `skillAugmentedPct`, `skillLeverageScore`, `resolutionVelocityScore`. Composite formula updated to 25/20/20/15/10/10 weights (Clarity / Velocity / Accuracy / CLI / Resolution / Skill Leverage). Session records written to `hace-sessions.jsonl` for trend analysis.
- **Skill Utilization Ratio panel** (`costDashboard.ts`) — Dedicated panel showing `$skill_spend / $session_spend` as a large highlighted number with a bar chart and contextual alert when below 1%. Also added to the Executive Summary grid.
- **Zero-Skill Session Alert panel** (`costDashboard.ts`) — Red-bordered panel listing sessions that cost ≥$1.00 with zero skill invocations in the last 14 days. Motivates users to invoke skills and activates ROI tracking.

### Changed (terminology)

- "API Score" → **"Agent Quality Index"** everywhere in the dashboard and panel headers.
- "Prediction" pill → **"Recommendation"** with "Awaiting data" state when no outcome history exists.
- "Attribution" sub-score → **"Cost Tracking Accuracy"** in the Agent Quality Index breakdown.
- "Efficiency" sub-score → **"Skill ROI"** to distinguish from MCP Ops Efficiency.
- HACE panel renamed **"Session Efficiency (HACE 2.0)"**.
- `buildScoreBannerHtml` label "Efficiency" → **"MCP Ops Efficiency"** to disambiguate from the skill ROI sub-score.

### Before / After

| Metric | Before | After |
|---|---|---|
| `attributionScore()` formula | `clamp(scorePct × 100)` | `clamp(scorePct)` |
| proposalOutcome.jsonl bootstrap | Silent no-write on empty caller | Reads proposals from file |
| Hook warning in promptExcerpt | 4× repeated noise text | Stripped before tokenize |
| minProposalConfidence default | 50 | 70 |
| Repo affinity single-signal cap | 30 pts (uncapped) | 15 pts |
| Prediction when no data | "0%" | "Awaiting data" |
| HACE metrics | 4 (clarity/velocity/accuracy/CLI) | 6 (+TTR, +skill leverage) |
| Skill Utilization Ratio | Not displayed | Prominent panel + exec summary |
| Zero-skill $1+ sessions | No alert | Red-bordered alert panel |

### Post-audit remediation (2026-06-24)

Second-pass fixes from the full 15-phase QA audit — addresses every "NOT WORKING" finding.

#### Fixed

- **`session-stop` hook never wired** (`hookHandlers.ts`) — `recordSessionProposalOutcome` was imported but never called; no `session-stop` case existed in `handleHookRequest`. Added `handleSessionStop()` + `case "session-stop"` dispatch. Every session end — including zero-invocation sessions — now writes a record to `proposalOutcome.jsonl`. This was the root cause keeping the entire learning stack inert.
- **Zero-invocation sessions silently dropped** (`proposalOutcome.ts`) — Early return when `names.length === 0` meant sessions where no skill was invoked produced no calibration signal. Removed the early return; zero-invocation records are now written (they are the most important signal for confidence decay).
- **AQI inflated by empty-state defaults** (`agentPerformanceIndex.ts`) — `taskCompletionScore` returned 100 and `humanCorrectionScore` returned 100 when no runs/feedback existed, inflating a fresh-install AQI from ~20 (F) to 40 (D). Both functions now return `NO_DATA = -1`; the composite excludes `NO_DATA` sub-scores and redistributes their weight proportionally. A zero-data install now correctly scores F.
- **`skillEfficiencyScore` cold-start inflates AQI** (`agentPerformanceIndex.ts`) — Was returning 50 (neutral) when `runs.length === 0`, contributing 7.5 phantom points to AQI. Now returns `NO_DATA` and is excluded from the composite when no invocations have been recorded.
- **`adx-schema-check` false positive** (`skills_library/manifest.json`) — Globs `**/adx*` and `**/*adx*` matched any filename containing "adx", including the extension's own source files (e.g. `adx-schema-check.ts`). Replaced with `["**/*.kql", "**/adx/**", "**/*kusto*", "**/adx-schema*"]` — only fires on actual KQL files, dedicated ADX directories, or Kusto-named files.
- **`pdf` glob false positive** (`skills_library/manifest.json`) — `**/*.pdf` fired on any PDF file present in the repo (documentation, licensing, marketplace listing). Replaced with workflow-specific patterns: `**/pdf/**/*.pdf`, `**/reports/**/*.pdf`, `**/pdf*.py`, `**/pdf*.ts`, `**/pdf*.js`, `**/generate*pdf*`, `**/*pdf*generator*`.
- **Transcript artifact names polluting attribution** (`skillPathUtils.ts`) — Single-word verbs and package-manager strings (`nnpm`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `node`, `deno`, `pip`, `pip3`, `conda`, `venv`, `poetry`, `make`, `rake`, `gulp`, `grunt`) were parsed as skill names from session transcripts, surfacing as "skills" in the dashboard with fabricated ROI figures. Added to `DENYLIST`. Retroactive cleanup removes existing artifact entries from stored `cost-attribution.json`.
- **`.bak` files accumulating without bound** (`learningPrune.ts`, `costAttribution.ts`) — `pruneBackupFiles` was count-only (keep 5 newest) and only ran on the workspace learning directory. Added 7-day time-based expiry alongside the count cap. `resetMisattributedData` now also prunes the global `~/.claude/learning/` directory where 30+ `.pre-reset-*.bak` files had accumulated undetected.
- **HACE panel invisible when no data** (`efficiencyMetrics.ts`) — `buildHacePanelHtml` returned `""` on `noData: true`, making the entire HACE section disappear from the Efficiency panel. Now renders a visible panel showing CLI Efficiency (the one measurable component) plus `—` placeholders for transcript-based scores, with clear guidance on when the full panel activates.
- **`haceMetrics.ts` source missing from repo** — The compiled `haceMetrics.js` existed in `extension/out/` but the TypeScript source had been deleted in v1.0.82. `haceMetrics.ts` has been restored to version control. `costDashboard.ts` updated to import from the source module.

#### Changed

- **Dormancy threshold halved** (`proposalOutcome.ts`) — Dormancy triggers at ≥5 sessions with acceptance < 5% (was ≥10). Confidence decay begins at ≥3 sessions with acceptance < 10% (was ≥5). False-positive skills are now suppressed in roughly half the time.

#### Before / After (post-audit)

| What | Before | After |
|------|--------|-------|
| `session-stop` dispatch | Not wired — `proposalOutcome.jsonl` never written | Wired — every session writes an outcome record |
| Zero-invocation sessions | Silent no-write (early return) | Written as 0-acceptance records |
| AQI on zero runs | 40/D (Completion 100%, Correction 100% defaults) | ~15/F (NO_DATA excluded from composite) |
| `skillEfficiencyScore` cold-start | 50 neutral (inflates AQI) | NO_DATA (excluded from composite) |
| `adx-schema-check` proposal | Fires on any file containing "adx" | KQL files, `adx/` dir, or Kusto-named files only |
| `pdf` proposal | Fires on any `.pdf` file in repo | Fires on PDF workflow code only |
| `nnpm` in Top Skills | "$308 · HIGH ROI · disable → save $616/mo" | Rejected at parse time; no longer stored |
| Backup file cleanup | Count-only (5), workspace dir only | 7-day expiry + count cap; global dir also pruned |
| HACE panel visibility | Hidden (`""`) when no session data | Always visible; shows CLI score + pending placeholders |
| Dormancy threshold | ≥10 sessions, decay at ≥5 | ≥5 sessions, decay at ≥3 |

### Adoption Intelligence System (2026-06-24)

Addresses root causes of <1% skill utilization and 6% acceptance rate.

#### Added

- **`adoptionIntelligence.ts`** — New module: `computeAdoptionMetrics`, `computeSkillAdoptionStats`, `enrichProposal`, `buildAffinityAreas`, `shouldSurfaceProposals`, `formatAdoptionDashboardHtml`.
- **Skill Adoption Intelligence dashboard panel** (`costDashboard.ts`) — Visible inside the Learning section with acceptance rate, precision, recall, F1, total time saved, top adopted/rejected skills, dormant skill list, user affinity areas, and a progress-toward-targets table (30d/60d goals).
- **Proposal explainability fields** (`taskSkillProposals.ts`) — `TaskSkillProposal` extended with `whyText`, `estimatedMinutes`, `acceptanceRate`, `successRate`, `successScore`, `trend`. Every proposal now carries a human-readable "why this skill" string and a time-saved estimate.
- **Benefit estimate library** — 35 skills mapped to realistic minute-saved estimates (`estimateBenefitMinutes`). Examples: `terraform-plan-review` 20 min, `ci-pipeline-debug` 25 min, `vitest-extension-testing` 8 min.
- **Rejection tracking** (`proposalOutcome.ts`) — `recommendation-feedback.jsonl` written at session end via `recordSessionRejectionFeedback`. Every proposed-but-not-invoked skill is recorded with `accepted: false, reason: "ignored"`. Provides signal for future dismissal UI.
- **Smart proposal timing** (`adoptionIntelligence.ts`) — `shouldSurfaceProposals()` avoids re-proposing on every prompt. Proposals surface on: first prompt of session, first kubectl/terraform/pipeline/error/ADX/publish signal, then every 2nd prompt with a 3-proposal-per-session cooldown.
- **User affinity profile** — `buildAffinityAreas()` maps invoked skills to areas (Infrastructure, CI/CD, Testing, Azure, etc.) for personalized signal in future ranking.

#### Changed

- **Confidence scores now differentiated** (`taskSkillProposals.ts`) — Glob-only proposals no longer hardcode 55%. New dynamic formula: `(40 if installed else 30) + specificityScore + affinityBoost + historyBoost + acceptanceBoost - penalty`. A deeply-specific glob (`**/mcp-servers/**/*.js`) scores ~70%; a shallow extension glob (`**/*.sh`) scores ~40-50%. Historical acceptance adds up to +25 pts.
- **Skill success score** — Composite `acceptance×50% + success×30% + reuse×20%` used to rank top-adopted skills in the dashboard.

#### Before / After (Adoption Intelligence)

| What | Before | After |
|------|--------|-------|
| Proposal explainability | `"Workspace files match **/*.ps1"` | `"detected: **/*.ps1 · 0% acceptance · ~8min saved"` |
| Glob-only confidence | Flat 55% for all | 30–80% based on specificity + history |
| Rejection tracking | Not stored | `recommendation-feedback.jsonl` per session |
| Adoption metrics | No panel | Full panel: acceptance/precision/recall/F1 + top adopted/rejected + targets |
| Smart timing | Every prompt | First prompt + signal moments + 3/session cooldown |
| User affinity | Not tracked | `buildAffinityAreas` maps invocations to work areas |

---

## [1.0.89] - 2026-06-21

**Summary:** Gap closure program — recommendation success chain, repository affinity, adaptation effectiveness index, and dashboard performance fixes.

**Theme:** Learning loop closure — converting all 10 platform gaps into production implementation.

### Added

- **Recommendation Success Chain** (`proposalOutcome.ts`) — per-session funnel record tracking proposed → invoked → not_invoked; `precisionScore()` now reads from `proposalOutcome.jsonl` acceptance rate when ≥3 session records exist
- **Repository Affinity Model** (`repoAffinity.ts`) — 10 filesystem signals detected and cached for 24h; boosts skill proposals based on repo tech-stack before any user task text
- **Adaptation Effectiveness Index** (`adaptationEffectiveness.ts`) — auto-resolves adaptations ≥7 days old with verdict classification: effective / mixed / neutral / harmful
- **Hook Health Dashboard** (`hookHealth.ts`) — per-hook reliability tracking in `hook-health.jsonl`; dashboard panel shows write success rate and last write time
- **Prediction Quality: Non-use Penalty + Historical Success** — proposed-but-ignored skills accumulate penalty (capped 40); skills with ≥3 invocations earn historical success boost (up to +30 pts)
- **ROI Intelligence Schema** (`runsStore.ts`) — `uninterrupted_ms` field added to run metadata; empirical measurement queued for v1.0.90

### Changed

- **Dashboard performance** (`commandsDashboard.ts`) — `forceCollect` now conditional on attribution file mtime change; second dashboard open in same session drops from 3365ms to ~10ms via fingerprint cache hit
- **Feature flags** (`featureMode.ts`) — added `recommendation.funnel`, `hook.health`, `repo.affinity` at Professional level
- **Proposal scoring** (`taskSkillProposals.ts`) — `scoreSkillForTask` now integrates affinity boost, non-use penalty, and historical success before threshold check

### New Dashboard Panels

- Recommendation Funnel · 30d — acceptance rate, invocation rate, success rate
- Hook Health · Today — hook calls, detections, writes, write success %
- Repository Affinity — detected signals and boost points per skill
- Adaptation Timeline — verdict badges (✅ effective / ⚠ mixed / — neutral / ❌ harmful)

### Fixed

- **`infra-cost-guard` false-positive proposals** — deduplicated tokens, added two-signal requirement (score < 40 + signalTypes < 2 filtered out)
- **`mcp__filesystem__search_files` missing from attribution hook matcher** — hook now matched `search_files`, fixing silent run drops
- **Executive Summary "Top Action" empty-state advice** — when learning loop is empty, action now reads "Invoke skills → learning begins" instead of "Reset attribution"

### Before / After

| Metric | Before | After |
|---|---|---|
| Dashboard re-open (no work) | 3365ms | ~10ms (snapshot hit) |
| Dashboard open after work | 3365ms | ~1000ms (rebuild) |
| Proposals per session | 12 (noise) | 2–4 (specific) |
| `infra-cost-guard` confidence | 75% (false positive) | Filtered out |
| Hook matcher coverage | `read_file`, `search_in_file` | + `search_files` |
| Attribution subscore | 100% (wrong) | 35% (correct) |

### New telemetry files

| File | Content |
|---|---|
| `proposalOutcome.jsonl` | Per-session funnel: proposed → invoked → not_invoked |
| `hook-health.jsonl` | Per-hook: skill detection + write success |
| `repo-affinity.json` | Repo tech-stack fingerprint (24h TTL) |
| `adaptation-log.jsonl` | Adaptations with AEI verdicts |

---

## [1.0.88] - 2026-06-21

**Summary:** Prediction accuracy fixes — false-positive proposals eliminated, hook matcher gap closed, Executive Summary guidance corrected.

**Theme:** Signal quality — removing noise so that when learning data accumulates, precision metrics reflect reality.

### Fixed

- **`infra-cost-guard` proposed at 75% confidence from session warning text** (`taskSkillProposals.ts`) — Hook-injected session-size messages (`"Long session (warn) — tighten skill set..."`) were included verbatim in `promptExcerpt` and tokenized. The word `"warn"` appeared 4× (one per repeated hook warning), each scoring +15 against `infra-cost-guard`'s description for a total of 60 pts → 75% confidence. Three-part fix: (1) added `"warn"`, `"long"`, `"tighten"`, `"context"`, `"session"` to `LOW_SIGNAL_TASK_TOKENS`; (2) deduplicated tokens with `[...new Set(tokenize(promptText))]` so each word scores once; (3) added two-signal requirement — proposals with score < 40 and fewer than 2 independent signal types are now filtered out.

- **`mcp__filesystem__search_files` absent from attribution hook matcher** (`hookOps.ts`, `hookHandlers.ts`) — `ATTRIBUTION_HOOK_MATCHER` and Kiro `toolTypes` included `mcp__filesystem__search_in_file` but not `mcp__filesystem__search_files`. Skill invocations via `search_files` (e.g. searching for `SKILL.md`) fired the hook but were not matched, silently dropping runs. Both arrays and the `extractSkillName` handler extended to include `mcp__filesystem__search_files`. Migration function auto-updates live hook configs on next workspace load.

- **Executive Summary "Top Action" shows wrong advice when learning loop is empty** (`costDashboard.ts`) — When attribution hooks are freshly installed (confidence ~35%) but no `runs.jsonl` data exists yet, the panel showed `"Reset attribution → +20 API pts"`. Reset is a no-op when there is nothing to reset. Added a pre-check: when `learningRate < 5%` AND `precision < 5%` AND `attribution ≥ 30%`, the action now reads `"Invoke skills in agent sessions → learning loop begins"`.

- **`mcp-agent-hints.md` missing — CHANGELOG.md read 14× per session** — File did not exist, so agents had no cache guidance. `CHANGELOG.md` (105 KB) was loaded in full on every analysis cycle, wasting ~53k tokens (~$0.16/cycle). Created `.claude/learning/mcp-agent-hints.md` with rules: use `search_in_file` for version lookups in CHANGELOG.md, cache `extension/src/` and root directory listings within a task.

### Changed

- `ATTRIBUTION_HOOK_MATCHER` constant: `...mcp__filesystem__search_in_file` → `...mcp__filesystem__search_in_file|mcp__filesystem__search_files`
- Kiro `.kiro.hook` `toolTypes` array: added `"mcp__filesystem__search_files"` to keep parity with Claude/Cursor matchers

### Before / After

| Metric | Before | After |
|---|---|---|
| `infra-cost-guard` proposal confidence | 75% (false positive) | Filtered out |
| Proposals with single weak signal | Pass at score ≥ 20 | Filtered: score < 40 + signalTypes < 2 |
| Hook matcher coverage | `read_file`, `search_in_file` | + `search_files` |
| Kiro toolTypes count | 7 | 8 |
| Executive Summary guidance (empty state) | "Reset attribution" | "Invoke skills → learning begins" |
| CHANGELOG.md reads per session | 14× full (105 KB each) | search_in_file only |

---

## [1.0.87] - 2026-06-21

**Summary:** Learning loop unblocked — `runs.jsonl` now populates from MCP file reads; General API cost corrected from $9/M blended to per-type rates.

**Theme:** Adaptive intelligence — making Learning Timeline, Prediction, and Optimization Center genuinely data-driven.

### Fixed

- **`runs.jsonl` never populated when using MCP filesystem tools** (`hookOps.ts`, `hookHandlers.ts`) — `ATTRIBUTION_HOOK_MATCHER` was `"Skill|Read|read|fs_read|fileread"`, which doesn't match `mcp__filesystem__read_file`. Projects using MCP Force Mode or CLAUDE.md-mandated MCP tools never recorded skill invocations because the hook never fired. Matcher extended to include `mcp__filesystem__read_file` and `mcp__filesystem__search_in_file`. `extractSkillName` handler updated to match. Kiro `toolTypes` array updated. Live `.claude/settings.json` patched immediately without requiring a hook reinstall.

- **General API cost inflated ~9.8× by blended $9/M rate** (`transcriptParsers.ts`, `costAttribution.ts`) — `tokenCostUsd(totalTokens)` applied Sonnet's 50/50 blended rate ($9/M = avg of $3/M input + $15/M output) to ALL token types, including cache reads at $0.3/M. In practice, long Claude sessions are dominated by cheap cache reads, causing $952 actual hook-measured spend to show as $9,164 in the General API panel. `ParsedTranscript` now carries a `cost` field computed from actual per-type rates per usage line (using `estimateUsageCostFromRaw`). `computeGeneralApiSpend` prorates this accurate cost to the general-API token portion rather than re-applying the blended rate.

### Impact on metrics (post-fix)

| Metric | Before v1.0.87 | After v1.0.87 |
|---|---|---|
| runs.jsonl (MCP workspaces) | Always empty | Populates on skill file reads |
| General API cost | ~$9,164 (blended $9/M) | ~$936 (matches hook-measured) |
| Learning Timeline | Empty (no invocations) | Entries appear as skills are read |
| Prediction F1 | 0% (no data) | Improves as invocations accumulate |
| API Score Precision | 0% | Improves as proposals convert |
| API Score Learning | 0% | Grows with each session |

### How the fix works end-to-end

```
Agent reads .claude/skills/self-learning/SKILL.md
  ↓ PostToolUse fires (matcher now includes mcp__filesystem__read_file)
  ↓ curl → http://127.0.0.1:4895/hook/skill-invoke
  ↓ extractSkillName("mcp__filesystem__read_file", {path: "...SKILL.md"})
       → skillFromPath() matches /\.claude\/skills\/([a-z][a-z0-9-]*)/ → "self-learning"
  ↓ appendSkillRun(cwd, { skill: "self-learning", invoked: true, source: "skill-invoke-hook-v2" })
  ↓ runs.jsonl grows → skill-stats.json updated → Learning Timeline shows entry
  ↓ Prediction precision computable → API Score Precision > 0%
```

---

## [1.0.86] - 2026-06-21

**Summary:** E2E production validation — 6 critical bugs fixed, prediction noise eliminated, adaptation log wired, false hook warning resolved, vitest skill lint fixed.

**Theme:** Quality audit & intelligence accuracy

### Fixed

- **Attribution subscore double-multiplication** (`agentPerformanceIndex.ts`, `statusBarManager.ts`, `costDashboard.ts`) — `scorePct` is stored as integer 0–100; multiplying by 100 again clamped everything to 100% and inflated API Score from 32 (F) to 45 (D). Now reads the value directly. API Score is now accurate.
- **Attribution alert never showed** (`statusBarManager.ts`) — same `* 100` bug made `pct` = 3500, always ≥ 80, so the alert bar was always hidden even when attribution was broken. Now shows correctly when < 80%.
- **False "Attribution PostToolUse hook not configured" warning** (`claudeVscodeAttributionGap.ts`) — hook detection only checked for `skill-invoke-watch.js` in the command string; the current hook uses a curl POST to `/hook/skill-invoke`. Detection now recognizes both forms; warning no longer fires when hook is properly configured.
- **Catch-all glob proposals polluting prediction** (`taskSkillProposals.ts`) — fallback proposal loop added skills matched only by `**/*`, `**/*.*`, or `**/*.md` at 55% confidence, bypassing the per-skill scorer that already filtered catch-alls. Skills matched only by catch-all globs are now skipped in the fallback path. Reduces over-prediction from 12 noise proposals to 0–2 specific-match proposals per session.
- **Adaptation log not written on attribution reset** (`commandsUsage.ts`) — `appendAdaptationEvent` was never called from the Reset Mis-attributed Cost Data flow. Now records an `attribution_reset` event with before/after counts.
- **vitest-extension-testing SKILL.md missing YAML frontmatter** (`.claude/skills/vitest-extension-testing/SKILL.md`) — caused infinite SKILL lint error loop on every cost-control hook refresh cycle. Frontmatter block added with correct globs.

### Impact on metrics (post-fix)

| Metric | Before v1.0.86 | After v1.0.86 |
|---|---|---|
| API Score (actual) | 45/100 D (inflated) | 32/100 F (correct) |
| Attribution subscore | 100% (wrong) | 35% (correct) |
| Attribution alert bar | Always hidden | Shown when < 80% |
| Hook warning | False positive | Cleared |
| Proposals per session | 12 (noise) | 2–4 (specific) |
| Adaptation log | Empty | Records resets |

---

## [1.0.85] - 2026-06-21

**Summary:** v1.1 UX Modernization — unified intelligence platform: 8 bars → 3, Executive Summary, 9 collapsible dashboard sections, Learning Timeline, Prediction Intelligence, Optimization Center, Governance panel, Feature Modes, adaptation log, and 3 new toggle commands.

**Theme:** "Large collection of features" → "Unified intelligence platform" (Maturity Level 3 → 4)

### Added

- **Status bar redesign: 8 bars → 3 signal bars** — `statusBarItem` repurposed as API Score bar (`$(sparkle) API A (84)` / `$(warning) API F (32)`); `usageStatusBarItem`, `projectTierStatusBarItem`, `workspaceFolderStatusBarItem` hidden (info moved to Executive Summary); new `attributionAlertBarItem` (conditional, only visible when attribution < 80%; click → resetAttribution). `refreshApiScoreStatusBar` replaces `refreshStatusBar`.
- **Executive Summary panel** (`costDashboard.ts`) — 6 metric cards rendered first on every dashboard open: API Score · Attribution · Prediction · ROI · Cost Today · Top Action. Each card shows current value, grade/band, and one-line recommendation.
- **9 collapsible `<details>` sections** in dashboard body — Health · Learning · Skills · Cost · Agent Performance · Prediction · Efficiency · Telemetry · Optimization (collapsed by default where low urgency).
- **Learning Timeline** (`learningTimeline.ts`) — `buildLearningTimeline(target, days)` reads `runs.jsonl` and cross-references proposals to produce per-day invocation/over-prediction events. `formatLearningTimelineHtml` renders grouped timeline with confidence-delta annotations.
- **Prediction Intelligence panel** — per-skill precision/recall/F1 computed from proposals vs runs; over-predicted (0 uses) and most-accurate skill tables rendered in Prediction section.
- **Optimization Center** — Governance panel with compliance checklist (5 items), runs.jsonl / mcp-usage.jsonl size, attribution confidence, provenance status.
- **Feature Modes** (`featureMode.ts`) — `type FeatureMode = 'starter' | 'professional' | 'power' | 'team'`. `isFeatureAvailable(feature)` gates dashboard sections. New `claudeSkills.featureMode` setting (default: `"professional"`). Prediction gated behind `professional`; Governance behind `power`.
- **Adaptation Log** (`adaptationLog.ts`) — `appendAdaptationEvent` / `readAdaptationLog` write `.claude/learning/adaptation-log.jsonl`. Events written on attribution hook install and cost-control hook install. Adaptation Timeline rendered in Learning section.
- **3 new toggle commands** (replace 6 enable/disable pair commands):
  - `claudeSkills.toggleMcpForce` — single toggle for MCP-Force Mode
  - `claudeSkills.manageMcpServers` — quick-pick to enable/disable Filesystem + CLI MCP servers
  - `claudeSkills.manageEfficiencyGuards` — multi-select to toggle CLI Loop Guard + Dir Cache Guard

### Changed

- `refreshCreditStatusBar`: token count removed from status bar text (moved to tooltip); text now shows only cost — `$(credit-card) $0.42` (cleaner).
- `refreshUsageStatusBar` / `refreshProjectTierStatusBar`: converted to no-ops that call `.hide()` — info surfaced in Executive Summary instead.
- `costDashboard.ts`: `buildExecutiveSummaryHtml`, `buildPredictionIntelligenceHtml`, `buildGovernancePanelHtml` added as helper functions. `readCachedEnrichedRuns` added to imports (replaces illegal dynamic `require`).
- `workspaceSkillSync.ts`: `ensureAttributionHooksActive` and `ensureCostControlHooksActive` now call `appendAdaptationEvent` on first install.
- `claudeSkills.officialSkillsCheckOnSession` setting removed (always-on since v1.0.84); replaced by `claudeSkills.featureMode`.

### Tests

- 463/463 pass (no regression from v1.0.84 baseline)
- `featureMode.ts`: fully type-safe; covered by compilation
- New modules (`learningTimeline.ts`, `adaptationLog.ts`, `featureMode.ts`) have type-safe interfaces

---

## [1.0.84] - 2026-06-21

**Summary:** Production readiness improvements — attribution stale-port fix, proposal history boost, cost-control hooks auto-enabled, profile/manifest cleanup, Agent Performance Index, and audit CSV export.

**Theme:** Observability → Adaptive Intelligence (API Score: 32 → ≥55)

### Fixed

- **Attribution stale-port hook replaced on re-install** — `ensurePostToolHookRegistered` (`hookOps.ts`) previously detected any hook containing `/hook/skill-invoke` and returned early, leaving a dead port 51710 command in `.claude/settings.json` from pre-1.0.83 installs. The PostToolUse hook never reached the extension server (port 4895), causing equal-split mis-attribution (20% confidence). The function now replaces stale-port commands in-place before the early-return check. After running **Reset Mis-attributed Cost Data**, attribution confidence rises from 20% toward 74%+.
- **`manifest` false skill attribution removed** — Files named `manifest` (e.g. `skills_library/manifest.json`) matched the skill-invoke hook's path pattern and were recorded as `skill: "manifest"` runs, appearing as rank-3 in the top-skills dashboard at $0.133. Added `"manifest"`, `"package"`, `"readme"`, `"changelog"`, `"license"` to `SKILL_DENYLIST` in `hookHandlers.ts`.
- **Archived skills no longer applied from profile** — `processSessionSkillApplyRequest` in `sessionSkillApply.ts` now filters the profile skill list against the library manifest before applying. Skills removed from `manifest.json` in prior releases (e.g. `adx-schema-check`, `algorithmic-art`) are silently skipped; required platform skills are always kept.

### Changed

- **Proposal engine — history boost** (`taskSkillProposals.ts`) — `scoreSkillForTask` now reads recent invocations from `runs.jsonl` via `buildRecentSkills(target)` and applies +25 (used in last 7 days) or +15 (last 30 days) to the confidence score. Catch-all globs (`**/*`, `**/*.*`, `**/*.md`) no longer contribute the +20 glob bonus — they provide zero discriminative signal. Combined effect: proposals for skills already proven useful in this workspace surface higher; universal-glob skills stop inflating the list.
- **Cost control hooks auto-installed on workspace sync** (`workspaceSkillSync.ts`) — `ensureCostControlHooksActive` added alongside `ensureAttributionHooksActive` in `propagateWorkspaceSkillChange`. Session-size and daily-budget warning hooks now install automatically on first workspace open instead of requiring a manual command-palette invocation.
- **`profile.local.json` updated** — Removed 4 archived skills (`adx-schema-check`, `algorithmic-art`, `brand-guidelines`, `canvas-design`) and 2 merged skills (`ci-pipeline-debug`, `ci-preflight`). Added `github-actions-ci`, `vscode-extension-publishing`, `mcp-server-creation`, `vitest-extension-testing`.

### Added

- **Agent Performance Index (API Score)** (`agentPerformanceIndex.ts`) — New 0–100 composite KPI displayed as a dedicated panel in the cost dashboard above Efficiency Metrics. Sub-scores: Precision 25%, Attribution 20%, Skill Efficiency 15%, Learning Rate 15%, Task Completion 15%, Human Correction 10%. Grades A–F. Also persisted in `dashboard-snapshot.json` for external tooling.
- **Audit export command** — `Claude Skills: Export Skill Telemetry (CSV)` (command: `claudeSkills.exportTelemetry`) writes a CSV file (`skill-telemetry-YYYY-MM-DD.csv`) to the workspace root with columns: `timestamp, skill, agent, tokens, cost_usd, success, session_id, model, source`. Enables compliance export and external analysis.

### Tests

- +10 new tests (463 total, up from 453)
- `hookOps.test.ts`: stale-port skill-invoke hook replaced on re-install
- `taskSkillProposals.test.ts`: history boost ≥25 for 7-day runs; no boost for 35-day runs; catch-all glob adds no score
- `agentPerformanceIndex.test.ts`: 5 tests covering empty workspace, high attribution, learning rate, feedback penalty, perfect-inputs path
- `workspaceSkillSync.test.ts`: updated stale assertion — cost control hooks now auto-install during propagation

---

## [1.0.83] - 2026-06-21

**Summary:** MCP `edit_file` CRLF fix for Windows YAML files, proposal engine stop-word filter, skill library cleanup, and 2 new skills.

**Theme:** Quality — Windows compatibility, proposal precision, library hygiene

### Fixed

- **MCP `edit_file` CRLF compatibility** — `edit_file` silently failed on all Windows CRLF YAML files (`.yml` files checked out via Git with CRLF line endings). `fs.readFileSync` preserved `\r\n` but `old_string` always arrives with `\n` from JSON transport; `content.includes(oldStr)` returned false. Patch in `resources/mcp-servers/filesystem/index.js` normalizes to LF for matching and restores original line endings before writing — LF files are completely unaffected. Eliminates 3 wasted retry calls per YAML edit on Windows.
- **Proposal engine stop-word false positives** — `LOW_SIGNAL_TASK_TOKENS` in `taskSkillProposals.ts` only blocked 7 domain-specific words, so common English stop words ("the", "and", "for", "with", "that", "this", ...) generated confidence=100 proposals for unrelated skills (`theme-factory` via "name matches 'the'"; `claude-api` via "description mentions 'and'"). Expanded block list to ~55 English stop words (3–5+ chars). Proposal precision improves from ~67% to ~88%.

### Changed

- **`azure-infra-preflight` detect_globs tightened** (v1.0.1) — Previously triggered on any `*.tf` file, causing a $1.20/run misfire in repos without Terraform infrastructure. Globs now require `**/terraform/**/*.tf` so the skill only activates when a `terraform/` directory is present.
- **`ci-pipeline-debug` + `ci-preflight` merged → `github-actions-ci`** — Both skills had identical detect_globs, co-triggered on every CI file read, and covered overlapping workflows. Merged into a single `github-actions-ci` skill (failure debug table, `gh run view`, `act` reproduction, pre-flight checklist, Node version consistency note).

### Added

- **`github-actions-ci` skill** — Merged replacement covering CI failure debugging and pre-flight checklist for `.github/workflows/` files.
- **`vitest-extension-testing` skill** — Covers `.test.ts`, `.bench.test.ts`, `.solo.test.ts`, `.prune.test.ts`, and xvfb-run integration test patterns with common failure fixes and run commands.
- **`vitest`/`bench`/`github` keyword hints** — Added to `TASK_KEYWORD_HINTS` in `taskSkillProposals.ts` for accurate skill proposals.

### Removed

- **`algorithmic-art`, `brand-guidelines`, `canvas-design`, `slack-gif-creator`** — Removed from `manifest.json` (0 runs across 4 active sessions; role mismatch with DevOps profile). Directories kept on disk.
- **`ci-pipeline-debug`, `ci-preflight`** — Removed from `manifest.json` (superseded by `github-actions-ci`).

### Tests

- `mcpFilesystemServer.bench.test.ts` — 2 new tests: `edit_file` on CRLF file with LF `old_string` succeeds and preserves CRLF; LF file regression guard.
- `taskSkillProposals.test.ts` — 2 new tests: stop-word prompt must not elevate `theme-factory`/`claude-api` above confidence 25; meaningful tokens (`terraform`, `pipeline`) still score correctly.
- Suite: **453 pass / 0 fail** (was 448 in v1.0.82).

---

## [1.0.82] - 2026-06-21

**Summary:** Simplification wave 2 - 16 TypeScript source files and 9 legacy JS hooks deleted; 6 commands, 4 status bars, and 22 config settings removed; major modules merged to reduce maintenance surface.

**Theme:** Simplification - code surface reduction, dead feature removal, module consolidation

### Removed

- **Weekly report feature** - `weeklyReport.ts`, `weeklyReportBenefits.ts`, `vcsReportDelivery.ts`, `tierBenefitBenchmark.ts` and all associated tests deleted. Commands `configureWeeklyReportEmail` and `sendWeeklyReport` removed. Configuration section `weeklyReport.*` (12 settings) and `benchmarks.*` (4 settings) removed from `package.json`. Migration: export CSV from the cost dashboard instead.
- **Cycle commands** - `cycleBudgetMode`, `cycleContextFocusLevel`, `cyclePracticalFocusLevel` removed; use VS Code Settings (`claudeSkills.budget.mode`, `claudeSkills.contextFocus.level`, `claudeSkills.practicalFocus.level`) instead.
- **Zombie command** - `estimatePRCost` was declared in `package.json` with no source implementation; removed.
- **4 status bar items** - trust badge, budget mode, context focus, and practical focus status bars removed (low signal-to-noise). Remaining bars: usage, skills count, project tier, workspace folder, MCP health.
- **Config settings** - `practicalFocus.enabled` (inferred from presence), all `skillFeedback.taskDrift*` settings (4 settings, consolidated to a single toggle), all `optimizer.*` fine-tuning except `autoApply` (6 settings removed).
- **9 legacy JS hooks** - `task-drift-watch.js`, `budget-watch.js`, `prompt-context-watch.js`, `skill-invoke-watch.js`, `official-skills-watch.js`, `profile-init-watch.js`, `branch-sync.js`, `usageParse.js`, `hookPlatform.js` deleted. Only `terminal-watch.js` kept (native terminal telemetry). All hook functionality replaced by HTTP endpoints in `hookHandlers.ts`.
- **Test files for deleted hooks** - `focusHooks.test.ts`, `skillInvokeHook.test.ts` deleted; `featureIntegration.test.ts` and `cursorSkillAttribution.test.ts` updated.

### Consolidated (merge + delete)

- **`haceMetrics.ts` → `efficiencyMetrics.ts`** - HACE score types, session-file parser, and `computeHaceMetrics` moved inline; `haceMetrics.ts` deleted. `mcpStatusBars.ts` import updated.
- **`projectProfileDisplay.ts` → `projectProfile.ts`** - all display helpers (`buildProjectProfileView`, `formatProjectProfileStatusBarText/Tooltip`, `formatProjectProfileDashboardHtml`, `formatPlanEconomics*`, etc.) moved to the end of `projectProfile.ts`; duplicate stubs in `projectProfile.ts` removed. `projectProfileDisplay.ts` and its test deleted.
- **`dashboardCache.ts` → `dashboardPrecompute.ts`** - team economics cache and dashboard snapshot cache merged into `dashboardPrecompute.ts`, which now owns both the cache logic and the background warm-up queue. `dashboardCache.ts` deleted; 6 importers updated.
- **`generalApiSpend.ts` → `costAttribution.ts`** - `hookTokensForSession`, `generalApiTokensForSession`, `computeGeneralApiSpend`, and related types appended to `costAttribution.ts`; `generalApiSpend.ts` and its test deleted. 3 importers updated.

### Build

- `npm run compile` clean throughout all phases
- 448/449 tests pass (`sessionSkillApply` parallel timeout is a pre-existing resource contention flake; passes in isolation)
- VSIX: 4.26 MB, 608 files

---
## [1.0.81] â€” 2026-06-20

**Theme:** Simplification â€” ~50% reduction in code surface, hooks, flags, and caching modules.

**Highlights:**

- **Hook consolidation** â€” `context-focus-watch.js`, `practical-focus-watch.js`, `session-size-watch.js` merged into single `prompt-context-watch.js`; one composed message per `UserPromptSubmit` instead of three
- **Attribution consolidation** â€” 6 attribution modules (`attributionConfidence`, `attributionHealth`, `attributionTrust`, `attributionTrustConfig`, `attributionStrategy`, `systemMode`) merged into `attributionQuality.ts`; `attributionReset.ts` inlined into `costAttribution.ts`
- **Cache consolidation** â€” `teamEconomicsCache` + `dashboardSnapshotCache` â†’ `dashboardCache.ts`; `runRecording` + `runsIndex` + `learningStateIndex` â†’ `runsStore.ts`
- **Feature flag reduction** â€” 21 flags â†’ 3 (`autoOptimizer`, `communityBenchmarks`, `prCostEstimate`); 18 always-on flags replaced with direct code
- **Command module migration complete** â€” 6 old command files deleted; all commands registered via new `commandsXxx.ts` pattern
- **Dead hook removal** â€” `session-apply.js`, `task-skill-focus.js`, `file-split-advisor.js`, `skill-gap-detector.js`, `commit-cost-record.js` deleted
- **Auto-optimizer simplified** â€” removed auto-apply timer and rate limiter; optimizer now suggest-only until user clicks Apply; `autoOptimizerRateLimit.ts` deleted
- **Single MCP log path** â€” `terminal-watch.js` and `appendToolUse` now write only to workspace-scoped `<cwd>/.claude/mcp-usage.jsonl`; `TelemetryScope` setting removed
- **Task proposals approval removed** â€” approval workflow (`options[]`, `selectedOptionId`, `approvalStatus`) removed from proposals JSON; `taskSkillSetApproval.ts` deleted
- **VSIX artifacts removed** â€” 7 old `.vsix` files deleted from repo; `*.vsix` already in `.gitignore`

## [1.0.77] â€” 2026-06-19

**Summary:** Two bug fixes discovered during live benchmarking â€” `archiveSkill` Windows EPERM on temp-dir cross-directory rename, and `terminal-watch.js` misidentifying `cd` as the CLI name when commands are prefixed with `cd "path";`.

**Theme:** Hardening â€” Windows compatibility and telemetry accuracy

### Fixed

- **`archiveSkill` EPERM on Windows** (`skillArchival.ts:148`) â€” `fs.renameSync(src, dest)` throws `EPERM: operation not permitted` when source and destination are in different temp directories on Windows (a known cross-mount-point limitation). Applied the same `fs.cpSync` â†’ `fs.rmSync` pattern used in `restoreArchivedSkill` since v1.0.74. The `skillArchival.test.ts > restoreArchivedSkill > removes the archived copy after restore` test was failing intermittently on Windows CI.
- **`terminal-watch.js` CLI name extraction** (`inferCli`) â€” Claude Code prefixes every PowerShell tool call with `cd "<workspace>"; real-command`. The original `split(/\s+/)[0]` extracted `cd` as the CLI name, collapsing all real commands into a single useless bucket. `inferCli` now strips the leading `cd "<path>";` or `Set-Location "<path>";` prefix before extracting the first meaningful token. Real CLI names (`npm`, `git`, `node`, `terraform`, etc.) now appear correctly in the telemetry dashboard and KPI panel.

### Test results

- 99 test files, 531 tests â€” 100% pass after fix

---

## [1.0.76] â€” 2026-06-19

**Summary:** Native bash/PowerShell telemetry â€” `terminal-watch.js` PostToolUse hook captures every AI agent terminal command into `mcp-usage.jsonl`, auto-registered by `installCostControlHooks` on extension start; `computeCliKpi` extended to analyse both MCP CLI and native bash entries in a unified view; Azure E2E infrastructure benchmark (10 resources, 7 Terraform modules, GitHub Actions pipeline); real-telemetry dashboard generator.

**Theme:** AI Ops platform â€” closing the gap between MCP file telemetry and full agent execution observability

### Added

- **`terminal-watch.js`** (`resources/hooks/`) â€” PostToolUse hook for `Bash`, `PowerShell`, and `run_in_terminal` tool names. Infers exit code from output patterns (`Exit code: N`, PowerShell error record markers, `isError` flag), detects retries (same CLI failed within 60 s), appends `{ tool:"bash:<cli>", server:"bash", cli, command, exitCode, isRetry? }` to both global and workspace-scoped `mcp-usage.jsonl`. Fills the telemetry gap: previously only MCP CLI server calls were logged; now ALL AI terminal execution lands in the same log.
- **`McpUsageEntry.server?: "cli" | "bash"`** (`mcpUsageLog.ts`) â€” widens the discriminant to include native bash hook entries.
- **`McpUsageEntry.command?: string`** (`mcpUsageLog.ts`) â€” stores the full command string for native bash entries.
- **`computeCliKpi` extended** (`mcpUsageLog.ts`) â€” `isTerminalEntry` predicate replaces the `server === "cli"` filter; both MCP CLI (`cli:*`) and native bash (`bash:*`) entries now flow through the same success-rate, retry, duration-percentile, and recovery-rate analysis.
- **`ensureTerminalWatchHookRegistered`** (`hookOps.ts`) â€” builds the absolute `node "/path/terminal-watch.js" claude` command from `extensionPath` and appends one PostToolUse matcher entry; idempotent.
- **`isTerminalWatchHookConfigured(target)`** (`hookOps.ts`) â€” public check for status/diagnostic use.
- **`installCostControlHooks` auto-registers terminal-watch** (`hookOps.ts`) â€” `addedTerminal` wired into the existing write-once-if-any-changed pattern; no extra file I/O.
- **`tests/azure-infra-benchmark/`** â€” production-style Terraform infrastructure: Resource Group, Storage Account (TLS 1.2, versioning, diagnostic settings), Key Vault (RBAC auth, purge protection), ACR (Standard, admin disabled), Log Analytics Workspace, Application Insights, User-Assigned Managed Identity with 4 RBAC assignments, Container Apps Environment, Container App (identity pull, autoscale 1â€“3, APPINSIGHTS env wired). GitHub Actions pipeline: fmt â†’ validate â†’ plan â†’ apply â†’ docker build â†’ push â†’ `az containerapp update` â†’ health verify. Full E2E benchmark report (`BENCHMARK_REPORT.md`).
- **`tests/telemetry-dashboard/generate-dashboard.mjs`** â€” reads `~/.claude/learning/mcp-usage.jsonl` and `runs.jsonl`, computes real metrics (sessions, token waste, repeated reads, CLI recovery rate, native bash coverage), writes self-contained `dashboard.html`. Usage: `node generate-dashboard.mjs --days 30`.

### Behavior changes

- `installCostControlHooks` now registers `terminal-watch.js` automatically the first time a workspace is opened after upgrading. Adds one PostToolUse entry matching `Bash|PowerShell|run_in_terminal` to `~/.claude/settings.json`. Idempotent on subsequent starts.
- Native bash commands now appear in the CLI KPI panel of the efficiency dashboard alongside MCP CLI calls, colour-coded with `server:"bash"` badge. Sessions with zero bash hook entries show `bash coverage: 0%` â€” expected until the hook fires at least once.

---

## [1.0.75] â€” 2026-06-19

**Summary:** CLI KPI Phase 1 â€” `computeCliKpi` delivers per-CLI success rate, total call count, retry count, timeout count, self-correction recovery rate, and P50/P95 duration percentiles; rendered in a new CLI efficiency panel in the cost dashboard and formatted in the output-channel efficiency report.

**Theme:** AI Ops observability â€” full CLI MCP execution telemetry

### Added

- **`computeCliKpi(entries, daysBack)`** (`mcpUsageLog.ts`) â€” aggregates CLI MCP server entries (`server:"cli"`) by CLI name; computes success rate (exitCode === 0), failure count, retry count (same CLI failed then succeeded within 30 s), timeout count, recovery rate, and P50/P95 duration percentiles per CLI. Grade thresholds (A â‰¥ 95%, B â‰¥ 85%, C â‰¥ 70%, D â‰¥ 50%) exported as `GRADE_THRESHOLDS`.
- **`CliKpi` / `CliCallStats` interfaces** (`mcpUsageLog.ts`) â€” typed output for the KPI function; `notEnoughData` flag when `totalCalls < 5`.
- **`EfficiencyMetrics.cliKpi`** (`efficiencyMetrics.ts`) â€” `computeCliKpi` wired into the main metrics pipeline; pre-filtered to the same `daysBack` window to avoid redundant date-parse passes.
- **CLI efficiency panel** (`efficiencyMetrics.ts`) â€” `buildCliKpiPanelHtml` renders per-CLI rows with mini bar chart, success-rate colour coding, retry/timeout/recovery pills, and duration percentiles when â‰¥ 3 calls exist.
- **Output-channel CLI section** (`efficiencyMetrics.ts`) â€” `formatEfficiencyReport` appends `### CLI KPI` block with success rate, grade, failure/retry/timeout counts, recovery rate, per-CLI breakdown, and `mostFailingCli` guidance.
- **`appendCliPatternHints` / `analyzeCliPatterns`** (`mcpUsageLog.ts`) â€” detects recurring CLI failure patterns across entries and writes actionable hints to `mcp-agent-hints.md`.

### Behavior changes

- Efficiency dashboard now shows a **CLI efficiency** sub-panel below the MCP waste panels. Requires at least one session with the CLI MCP server active to display data.
- `mcp-agent-hints.md` gains a `## CLI Patterns` section on the next dashboard open after CLI failures are detected.

---

## [1.0.74] â€” 2026-06-18

**Summary:** Full E2E QA audit pass â€” binary file guard in the MCP filesystem server, skill lifecycle pipeline fixes (archive bug, atomic restore, efficiency-driven archive/upgrade), 24 new tests (509 total), exported constants for grade thresholds and log retention, and `sync-library` as the canonical CLI subcommand name.

**Theme:** QA audit hardening â€” correctness, security, and observability

### Fixed

- **`archiveSkill` double-remove bug** (`skillArchival.ts`) â€” `removeSkill()` was called after `fs.renameSync()` on a path that no longer existed (dead code). Removed. Added comment explaining the invariant.
- **`bumpPatchVersion` wrong location** (`skillArchival.ts`) â€” version was bumped inside the archive directory after the move (semantically wrong). Now bumps the installed copy *before* `renameSync` so the archival event is stamped in the skill's version history.
- **`restoreArchivedSkill` unsafe rename** (`skillArchival.ts`) â€” `fs.renameSync` is not atomic across filesystem boundaries; a crash mid-operation leaves the skill in neither location. Replaced with `fs.cpSync` (copy first) then `fs.rmSync` (delete only after copy succeeds).
- **TypeScript type: `stat.skill`** (`costOptimizer.ts`) â€” `SkillUsageStat` uses `.name`, not `.skill`; fixed typo in archive suggestion loop.

### Added

- **Binary file guard in `read_file`** (`filesystem/index.js`) â€” rejects files larger than 50 MB or detected as binary (PNG, JPEG, PDF, ZIP, ELF, PE/EXE) via magic-byte check before reading into memory. Returns a clear error directing agents to `search_in_file` instead.
- **60-minute session cache TTL** (`filesystem/index.js`) â€” `pruneSessionCaches` now evicts entries older than `SESSION_CACHE_TTL_MS` (60 min) so long-running sessions never serve stale directory listings.
- **`ArchiveMeta` efficiency context** (`skillArchival.ts`) â€” `.archive-meta.json` now records `reason`, `roiBand`, `runs`, and `version` at archival time. All callers (`archiveSkill`, `runArchivalPass`) pass these fields.
- **`"archive"` and `"upgrade"` suggestion types** (`costOptimizer.ts`) â€” `OptimizationType` extended. `generateOptimizationSuggestions` now emits `archive` for LOW ROI + idle skills (â‰¥5 runs, â‰¥14 idle days) and `upgrade` for outdated skills with measured LOW ROI (â‰¥3 runs). Both appear in the dashboard and are actionable from the optimizer.
- **Archive/upgrade apply cases** (`autoOptimizer.ts`) â€” `applyOptimizationSuggestions` switch now handles `"archive"` (calls `archiveSkill` with opts) and `"upgrade"` (calls `upgradeSkillInWorkspace` with `force: true, confirmCost: false`). Previously both fell through to `default: skipped`.
- **Dynamic `allowedTypes` in `runAutoOptimizePass`** (`autoOptimizer.ts`) â€” replaces the hardcoded `disable|unused` filter. Adds `"archive"` when `auto_archive` is on and `"upgrade"` when `autoUpgradeOnLowRoi` is on, unifying what were three separate passes into the rate-limited suggestion pipeline.
- **`GRADE_THRESHOLDS` constant** (`mcpUsageLog.ts`) â€” exported `{ A: 90, B: 75, C: 60, D: 45, F: 0 }` replaces magic numbers in `scoreToGrade`. Makes grade boundaries visible and maintainable.
- **`MCP_LOG_MAX_BYTES` constant** (`mcpUsageLog.ts`) â€” exported `50 * 1024 * 1024`; used by `learningPrune.ts`. Doc comment explicitly notes that `daily-stats.json` does not exist â€” the actual artifact is `dashboard-snapshot.json`.
- **`safeDeliveryError` export** (`weeklyReport.ts`) â€” function was private; exported for direct unit testing of credential masking behavior.
- **`azure-infra-preflight` and `infra-cost-guard`** (`skills_library/manifest.json`) â€” two skill directories that existed on disk but were absent from the manifest. Skill detection would silently skip them.
- **42-test MCP security suite** (`tests/mcp-security.test.js`) â€” path traversal (8 cases), CLI allow-list enforcement (17 cases: all dangerous commands rejected, case normalization, `.exe`/`.cmd` strip), shell injection resistance (7 cases), binary file detection (8 cases). All pass.
- **`skillArchival.test.ts`** (19 tests) â€” archive, restore, round-trip, meta fields, version bump placement, `listArchivedSkills`, `candidatesForArchival` threshold logic.
- **`weeklyReport.test.ts`** (17 tests) â€” `isNoreplyEmail`, `shouldSendScheduledReport`, SMTP not-configured, no-recipient, `safeDeliveryError` masking (password / token / secret / smtp keywords).
- **`mcpUsageLog.test.ts` extensions** â€” `GRADE_THRESHOLDS` shape/ordering/clean-session grade A, `MCP_LOG_MAX_BYTES` value.
- **`skillLifecycle.test.ts` extensions** â€” `stampMissingVersionSidecars` (stamps missing, skips existing), `compareSemver` edge cases (v-prefix, partial version, missing segments).

### Changed

- **`runArchivalPass` efficiency context** (`autoOptimizer.ts`) â€” now computes `roiBand` from usage stats and passes it (with `runs`) to `archiveSkill` opts so archived skills carry their efficiency signal.
- **`generate_skills.py` subcommand name** â€” `sync-library` is now the primary name; `install` is the alias. Help text and usage example updated to match.
- **`mcp-server-creation` skill description** â€” trimmed from 545 to 431 chars (lint warning resolved).

### Documentation

- **README.md** â€” session cache TTL bullet, binary file guard bullet, `sync-library` primary name in CLI quick-start, `daily-stats.json` â†’ `dashboard-snapshot.json` in learning files table, pipeline stage table, disk-size bullet, and skill archival feature flag description.

---

## [1.0.73] â€” 2026-06-18

**Summary:** Native IDE tool operations (run_task, run_in_terminal, etc.) are now captured by PostToolUse hooks and logged to mcp-usage.jsonl alongside MCP server operations. Fills a gap where native tools were previously untracked, enabling complete observability across all agent tooling.

**Theme:** PostToolUse native tool logging â€” complete agent tooling visibility

### Added

- **Native tool operation logging** (`appendToolUse()` in `runRecording.ts`) â€” PostToolUse hooks now capture all IDE tool invocations, not just MCP operations. Native tools appear in `mcp-usage.jsonl` with `tool` field formatted as `native:<toolName>` (e.g., `native:run_task`, `native:run_in_terminal`) to distinguish them from MCP server operations.

- **PostToolUse hook handler update** (`handleSkillInvoke()` in `hookHandlers.ts`) â€” modified to call `appendToolUse()` for non-skill tools before returning, ensuring all native IDE tool operations are logged with full context (agent, sessionId, model, timestamps).

- **Dual-path native tool logging** â€” native tool operations are logged to both `~/.claude/learning/mcp-usage.jsonl` (global) and `<workspace>/.claude/mcp-usage.jsonl` (workspace-scoped), matching the existing MCP server logging pattern.

### Changed

- **Efficiency scoring now includes native tools** â€” KPI grades now reflect usage patterns across native tools (run_task, run_in_terminal, etc.) as well as MCP operations, providing complete observability of agent efficiency.

- **Scenarios 4 & 5 behavior change** â€” "Full file I/O observability" and "MCP Force Mode" now provide complete tooling observability (previously only MCP calls were logged; native tools left no trace). All tool invocations now appear in telemetry logs.

### Fixed

- **Gap in agent tool tracking** â€” native tool operations (`run_task`, `run_in_terminal`, etc.) that flowed through the PostToolUse hook handler were previously dropped before any logging occurred. Now properly captured and logged with consistent metadata alongside MCP operations.

---

## [1.0.72] â€” 2026-06-18

**Summary:** New `edit_file` MCP tool, session-level read/dir caches in the filesystem server, auto-fix command that converts detected inefficiencies into permanent hint rules, stale-lock recovery for MCP Force, and an accuracy-corrected efficiency scoring model.

**Theme:** MCP server v1.2 â€” edit_file, session caches, auto-fix hints, and scoring accuracy

### Added

- **`edit_file` MCP tool** (filesystem server v1.2) â€” replaces an exact string in a file; `old_string` must appear exactly once (errors if absent or ambiguous). Prefer over `write_file` for targeted edits. Registered in `CLAUDE.md` force-block alongside `read_file`, `write_file`, etc.

- **Session read/dir cache in filesystem server** â€” `read_file` skips a re-read when the file's `mtimeMs` is unchanged; `list_directory` returns the cached listing for the same session. Both caches are invalidated on `write_file`, `edit_file`, and `delete_file`. Caches from previous sessions are pruned on each `initialize` handshake to bound memory use.

- **`mcpAutoFix.ts` â€” auto-fix efficiency hints** â€” new module that converts detected MCP inefficiencies (hot files, excessive scans, large files, persistent cross-session patterns) into a `<!-- permanent-cache-rules -->` block inside `mcp-agent-hints.md`. The block survives session-hint refreshes and instructs agents to cache those files/dirs permanently.

- **`claudeSkills.applyMcpAutoFixes` command** â€” Command Palette entry that runs `applyMcpAutoFixesForTarget()` against the current workspace and reports how many permanent hint rules were written.

- **"Apply auto-fixes to hints" button** in the Efficiency panel â€” shown only when fixable issues exist (waste warnings, excessive scans, large files, or persistent cross-session hot files). Sits alongside the existing "Clear MCP Logs" button.

- **Auto-sync filesystem server binary on activation** (`syncFilesystemServerBinary()` in `mcpOfficial.ts`) â€” compares file size then SHA-1 of the bundled binary against the deployed copy; re-copies on mismatch so extension updates propagate automatically without a manual "Enable" step. Mirrors the existing `syncCliServerBinary()` fast-path added to `mcpCli.ts`.

- **Log auto-pruning** (`maybePruneLog()` in `mcpUsageLog.ts`) â€” when `mcp-usage.jsonl` exceeds 2 MB, entries older than 30 days are trimmed atomically (temp-file rename). The in-memory cache entry is cleared so the next read picks up the pruned content.

- **`summarizeCrossSessionPatterns` export** â€” `mcpUsageLog.ts` now exports this function; `extension.ts` uses it to pass cross-session data to the auto-fix command.

### Fixed

- **Stale lock recovery in MCP Force** (`mcpForce.ts`) â€” `clearStaleLock()` removes `.mcpforce.lock` files older than 30 s before each acquire attempt, preventing permanent deadlock after a VS Code crash. Tests added for concurrent-lock and race-condition scenarios.

- **`detectReadAfterWrite` accuracy** â€” now accumulates *all* write timestamps per path (not just the latest), so a read falling between two concurrent-agent writes is correctly flagged. Matches against the earliest qualifying write; clears only the writes that predated the read.

- **Efficiency scoring excludes no-op writes** â€” `computeScore()` subtracts auto-skipped writes from both the scoring denominator and the wasteful-ops count; sessions with many content-identical writes are no longer penalised for something the server already handled.

- **Uncapped warning arrays for accurate scoring** â€” `detectReadAfterWrite`, `detectAgentLoops`, and `detectExcessiveScans` now return all findings (previously capped at 5). The 5-item display cap is applied only at the `summarizeMcpUsage` return site, so the efficiency score reflects the true number of wasteful ops.

- **`writeMcpHints()` preserves permanent block** â€” session-hint refreshes no longer overwrite the `<!-- permanent-cache-rules -->` block written by `applyMcpAutoFixes()`.

- **`workspaceHookStatus` test fixture** â€” `guards` property added to `allOn` / `partial` fixtures to match the current `WorkspaceHookStatus` shape.

---
## [1.0.71] â€” 2026-06-18

**Summary:** The large-file self-correction hook is now enforced (not just advisory), hook file writes are atomic, and CLAUDE.md writes are concurrency-safe. MCP telemetry performance improved via per-call path memoization and a raised LRU cache.

**Theme:** Self-correcting large-file guard â€” enforced hook escalation, atomic writes, CLAUDE.md lock

### Added

- **Large-file read guard** (`file-split-read-guard` PreToolUse hook on `mcp__filesystem__read_file`) â€” fires *before* a second read of a file already recorded as large (>50 KB / 500 lines) in the large-file store. Returns `decision: "block"` and redirects the agent to `search_in_file` or a line-range read instead. First reads always pass through; the guard activates only when the file has already been read at least once this session.

- **Escalating PostToolUse enforcement** (`file-split-advisor`) â€” the hook now operates in two modes:
  - **Read 1:** advisory hint as before â€” the agent is informed and may continue.
  - **Read 2+:** returns `stopTask: true` for Claude Code (halts the tool chain) and a hard `MANDATORY SPLIT REQUIRED` message for all agents. The agent must complete the file split before it can proceed.

- **Paired hook install** â€” `installFileSplitAdvisorHook` now registers both the PostToolUse advisor and the PreToolUse guard together on the same `mcp__filesystem__read_file` matcher. `removeFileSplitAdvisorHook` removes both. Existing workspaces pick up the guard automatically on next extension activation.

### Changed

- **Atomic hook file writes** (`hookOps.ts`) â€” `.cursor/hooks.json`, `.kiro/hooks/*.kiro.hook`, and `.github/hooks/*.json` are now written via `writeJsonAtomic` (temp-file â†’ rename with retry), matching the approach used elsewhere in the codebase. A VS Code crash mid-write no longer corrupts hook files.

- **CLAUDE.md concurrent write protection** (`mcpForce.ts`) â€” `injectMcpForceClaude` and `removeMcpForceClaudeBlock` now acquire an exclusive lock file (`CLAUDE.md.mcpforce.lock`) before reading and writing CLAUDE.md, and use a temp-file rename for the write itself. Two VS Code windows targeting the same workspace simultaneously no longer risk corrupting CLAUDE.md.

- **`resolvePath` memoized per summarize call** (`mcpUsageLog.ts`) â€” `fs.realpathSync` was called once per log entry per unique path on every `summarizeMcpUsage` invocation. A per-call `Map` cache now ensures each unique path is resolved at most once, cutting syscall count from O(n) to O(unique paths) for sessions with many entries.

- **LRU log cache raised from 20 â†’ 50 paths** â€” multi-root workspaces with many active log files no longer thrash the in-memory cache.

- **`detectReadAfterWrite` reports all writeâ†’read cycles** â€” previously only the first read-after-write per path was reported (a `seen` Set suppressed subsequent occurrences). Each independent writeâ†’read cycle on the same path is now reported separately; a second read after the same write produces no additional warning.

---

## [1.0.70] â€” 2026-06-18

**Summary:** Self-correcting hooks now extend from CLI failures to all MCP filesystem tool failures. Agents get immediate corrective hints on ENOENT, EACCES, access-denied, EISDIR, and other common errors â€” plus a learner that auto-promotes repeated project-specific failures into actionable patterns.

**Theme:** MCP filesystem error guard â€” self-correcting hooks extend to all MCP tool failures

### Added

- **MCP filesystem error guard** (`mcp-error-guard` PostToolUse hook on `mcp__filesystem__`) â€” fires whenever a filesystem MCP tool call returns `isError: true` and injects a corrective hint before the agent retries. Eight static patterns:
  - `outside allowed directories` â†’ add path to `allowedDirs` config
  - `ENOENT` / `no such file or directory` â†’ use `search_files` first
  - `EACCES` / `permission denied` â†’ check file ownership
  - `EISDIR` â†’ use `list_directory` instead of `read_file`
  - `ENOSPC` â†’ free disk space
  - `EROFS` â†’ read-only filesystem
  - `Invalid regex` (search_in_file) â†’ escape special characters
  - `Access denied` â†’ path outside allowed directories
  - Install/remove via `installMcpErrorGuardHook` / `removeMcpErrorGuardHook` in `hookOps.ts`.

- **MCP filesystem error learner** â€” `analyzeMcpErrors()` in `cliGuardLearner.ts` reads `mcp-usage.jsonl`, groups filesystem tool failures by `(tool, errorKey)`, and promotes patterns seen â‰¥ 2 times to `~/.claude/learning/mcp-guard-patterns.json`. Known signatures get an actionable hint automatically; unknown ones get `needsReview: true` so you can fill in the hint once without any code change. Runs at session start alongside the existing CLI learner. Session context reports how many MCP patterns need review.

- **Filesystem MCP server: structured error logging** â€” the catch block in `dispatchTool` now writes `errorSnippet: e.message.slice(0, 256)` to `mcp-usage.jsonl` (mirrors the CLI server's `stderrSnippet` field), giving the learner a stable substring to group on.

- **Filesystem MCP server: tool-content error responses** â€” tool execution failures now use `respond(id, { content: [{type:"text", text: e.message}], isError: true })` instead of `respondError` (JSON-RPC protocol error). This is correct per the MCP spec (protocol errors vs. tool errors) and ensures PostToolUse hooks receive the error message.

### Fixed

- `parseInt` â†’ `Number.parseInt` and `isNaN` â†’ `Number.isNaN` in `analyzeCliFailures` (SonarJS S7773 warnings).
- Backslash in `search_in_file` hint now uses `String.raw` template literal (SonarJS S7780 warning).

---

## [1.0.69] â€” 2026-06-17

**Summary:** Agents now self-correct on CLI failures, are blocked from re-scanning directories they already listed, resume with full last-session context, and all infrastructure skills route CLI/filesystem calls through MCP telemetry.

**Theme:** Adaptive agent loop â€” self-correcting hooks, session memory, dir-cache guard

### Added

- **CLI loop guard** (`cli-loop-guard` PostToolUse hook on `mcp__claude-skills-cli__run_command`) â€” injects a corrective `systemMessage` immediately after any CLI failure, before the agent decides what to do next. Seven cross-CLI patterns:
  - `terraform` exitCode=1 + ed25519 stderr â†’ RSA-4096 key instruction
  - `terraform` exitCode=255 â†’ `terraform init` missing
  - Any CLI + `AuthorizationFailed`/403 â†’ routes to `azure-rbac-diagnostics` skill
  - `kubectl`/`helm` + connection refused â†’ kubeconfig check
  - `git` + CONFLICT/index.lock â†’ conflict resolution
  - `gh` + not logged in â†’ `gh auth login`
  - Any CLI + timed out â†’ increase timeout parameter
  - Auto-installed when CLI MCP server activates. Enable/disable via Command Palette.

- **Dir cache guard** (`dir-cache-guard` PreToolUse hook on `mcp__filesystem__list_directory`) â€” blocks redundant directory scans within a session using an in-memory `Map<sessionId, Set<path>>` with 4-hour TTL. Cache miss â†’ allow + record. Cache hit â†’ `{ decision: "block", reason: "CACHE HIT: ..." }` â€” the scan never executes. Auto-installed when filesystem MCP server activates.

- **Last-session context at session start** â€” `buildLastSessionSummary()` reads the last 60 `mcp-usage.jsonl` entries and injects a one-paragraph `## Last session` block (project dir, files written, CLI calls) into both `profile-init` (general SessionStart) and `mcp-gate` (MCP-Force SessionStart). Only fires for sessions < 24 h old.

- **CLI outcome pattern hints** â€” `analyzeCliPatterns()` + `appendCliPatternHints()` in `mcpUsageLog.ts` mine the usage log for CLIs with â‰¥2 errors, emit a dated error-rate section into `mcp-agent-hints.md` alongside the existing filesystem hints, and are called automatically from the efficiency scoring pipeline.

- **`cwd` in CLI MCP log entries** â€” every `run_command` entry now includes the working directory so per-project CLI attribution and pattern analysis work correctly.

- **Two new skills** in `skills_library/`:
  - `azure-infra-preflight` â€” pre-deploy checklist: verify login, detect SSH key type (Azure rejects ed25519), check RG existence and auto-generate `import {}` blocks, gate on TF â‰¥ 1.6, write run-log.
  - `infra-cost-guard` â€” estimate ongoing charges from a Terraform plan or live resource list (Azure, AWS, GCP cost tables), emit teardown command before apply, write a teardown reminder after apply.

- **MCP tool declarations for 6 skills** â€” `ci-preflight`, `ci-pipeline-debug`, `terraform-plan-review`, `azure-resource-ops`, `gitlab-pipeline-ops`, `azure-rbac-diagnostics` now declare `mcp__claude-skills-cli__*` and `mcp__filesystem__*` in their frontmatter `allowed-tools`, so all CLI and file operations in these skills are captured in KPI telemetry.

- **`excessiveScans` in `writeMcpHints`** â€” directories listed 3+ times now appear in `mcp-agent-hints.md` with wasted-entry counts and a reference to the dir-cache-guard hook.

### Fixed

- **`writeMcpHints` cognitive complexity** â€” refactored into 6 section helpers (`hintWasteWarnings`, `hintAgentLoops`, `hintLargeFiles`, `hintReadAfterWrite`, `hintExcessiveScans`, `hintEfficiency`), each returning `string[]`. Main function is now a flat spread â€” complexity from 20 â†’ 3 (resolves SonarJS S3776).

- **CLI MCP `workspaceLogPath` not refreshed on extension activation** â€” the `else` (already-configured) branch for the CLI MCP server skipped `refreshCliConfig`, leaving the log path pointing at the previous project after a window switch. Now calls `refreshCliConfig` in that branch, mirroring the filesystem server.

- **4 new Command Palette commands missing from view menu** â€” `enableCliLoopGuard`, `disableCliLoopGuard`, `enableDirCacheGuard`, `disableDirCacheGuard` now appear under `group: "3_usage"` in `contributes.menus`.

### Changed

- `McpUsageEntry` interface gains an optional `cwd?: string` field (CLI server only).

---

## [1.0.68] â€” 2026-06-17

**Summary:** CLI MCP server now auto-starts alongside the filesystem server on extension activation, has its own status bar item, and appears in the MCP Health dialog. Two server-level bugs fixed.

**Theme:** CLI MCP server auto-start, status bar, and health dialog

### Added

- **CLI MCP server auto-start** â€” on extension activation (5 s delay, same block as the filesystem server), `needsCliMcpSetup()` detects whether `~/.claude/mcp-servers/cli/index.js` is deployed and registered; if not, `enableOfficialCliServer()` runs automatically and deploys it for all configured agents (Claude, Cursor, Kiro). If already configured, logs a confirmation and refreshes the status bar.
- **`mcpCliStatusBarItem`** â€” new status bar item (priority 91.5, immediately right of the KPI item) showing:
  - `$(terminal-cmd) CLI MCP Â· claude, cursor, kiro` (no background) when the server is registered for any agent
  - `$(warning) CLI MCP: setup needed` (warning background) when the server is missing or unregistered
  - Click navigates to the enable/disable command depending on current state.
- **`refreshCliMcpStatusBar()`** â€” module-level function called from `refreshAllImpl`, after the enable/disable commands, and after auto-start completes.
- **CLI MCP section in `showMcpHealth` dialog** â€” the `claudeSkills.showMcpHealth` modal now has a `â”€â”€ CLI MCP Server â”€â”€` block after the filesystem section: shows `Connected âœ“` with agent list and supported CLIs, or `Setup needed âœ—` with the enable command name.
- **`needsCliMcpSetup` and `getCliMcpServerStatus`** â€” now imported in `extension.ts` (were exported from `mcpCli.ts` but unused).
- **`mcp-server-creation` skill** â€” new entry in `skills_library/` documenting the full pattern for building, wiring, and debugging a stdio MCP server bundled inside this VS Code extension: server skeleton, two critical bugs pre-fixed, allow-list security, TypeScript deploy helper, auto-start wiring, status bar pattern, health dialog integration, PowerShell test harness, and deployment checklist.

### Fixed

- **CLI MCP server: premature exit kills async tool calls** â€” `process.stdin.on("end", () => process.exit(0))` fired before `spawn`-based tool calls (`run_command`) had time to complete, so only synchronous tools responded. Replaced with a `_pendingOps` / `_stdinEnded` gate: `process.exit(0)` is deferred until all in-flight `tools/call` handlers have resolved.
- **CLI MCP server: `tools/call` responses returned "no output"** â€” the server sent raw result objects (`{stdout, stderr, exitCode}`) instead of the MCP-required `content:[{type:"text",text:"..."}]` envelope. All `run_command` and `list_available_clis` responses now wrap in `{content:[{type:"text",text:"..."}], isError:bool}`. Error responses from `dispatchTool` catch blocks also use the content format with `isError:true`.

### Changed

- `claudeSkills.enableCliMcpServer` and `claudeSkills.disableCliMcpServer` commands now call `refreshCliMcpStatusBar()` in both the `onStatusChanged` callback and after the `await` â€” status bar updates immediately on manual enable/disable.

---

## [1.0.65] â€” 2026-06-16

**Summary:** MCP health and KPI are now visible in the status bar; a new Force Mode locks Claude to MCP-only file operations; the old lazy-proxy is silently retired on activation.

**Theme:** MCP health monitoring, Force Mode & proxy auto-migration

### Added

- **MCP Health status bar item** (`$(plug) MCP Connected` / `$(plug) MCP Â· N agents` / `$(warning) MCP: setup needed`) â€” shows live server readiness and which agents are configured. Clicking opens the MCP health report.
- **Agent KPI status bar item** (`$(pulse) KPI: A Â· N calls`) â€” shows the efficiency grade and call count for the last 24 h using the workspace-scoped MCP log; `ready` when no calls recorded yet. Clicking opens the same health report.
- **`mcpHealth.ts`** â€” `checkMcpHealth()` validates the server binary, per-agent config entries (Claude, Cursor, Kiro; Copilot always included via `package.json`), and recent activity; returns `"ready"`, `"config-issue"`, or `"no-activity"` with error strings and the list of configured agents.
- **`mcpForce.ts`** â€” MCP Force Mode: makes Claude use *only* MCP filesystem tools for file operations.
  - `enableMcpForcePermissions(target)` â€” adds `Read`, `Write`, `Edit`, `Glob`, `Grep` to the `permissions.deny` list in `.claude/settings.json`.
  - `injectMcpForceClaude(target)` â€” writes an `## MCP REQUIRED` block to `CLAUDE.md` listing the allowed MCP tools.
  - `revertMcpForcePermissions(target)` / `removeMcpForceClaudeBlock(target)` â€” undo both changes.
  - `isMcpForceActive(target)` â€” returns true when both the deny list and the CLAUDE.md block are in place.
- **MCP-force hooks** in `hookOps.ts` â€” `installMcpForceHook()` registers a `mcp-force` `UserPromptSubmit` hook and `installMcpGateHook()` registers a `mcp-gate` `SessionStart` hook in `.claude/settings.json`; `removeMcpForceHooks()` cleans both up.
- **Auto-start MCP server** â€” on extension activation (after a 5 s delay), if `needsFilesystemMcpSetup()` detects that the server binary is missing or Claude has no config entry, the filesystem MCP server is deployed and configured automatically; otherwise, the allowed-dirs list is refreshed for the current workspace.
- **`needsFilesystemMcpSetup()`** export in `mcpOfficial.ts` â€” returns `true` when the server script is missing or the Claude config has no `filesystem` entry (Copilot is excluded from this check as it registers via `contributes.mcpServers`).
- **`claudeSkills.clearMcpLogs` command** â€” prompts for confirmation then clears the global `~/.claude/learning/mcp-usage.jsonl`, the workspace-scoped MCP log, and `mcp-agent-hints.md`.

### Changed

- **MCP proxy retired** â€” `activateMcpOptimizer` (proxy install + consent flow) removed; replaced by `autoMigrateProxyIfActive()` which silently removes the proxy entry from `~/.claude.json` if it detects our legacy lazy-proxy is still active. No prompt, no data loss.
- **Status bar cleanup** â€” usage, trust badge, budget mode, context focus, and practical focus items are hidden in favour of the two new MCP items, reducing status bar clutter.
- **`upsertMcpServerEntry`** â€” `upsertClaudeServer` and `upsertCursorKiroServer` merged into a single function; behaviour identical.
- Log message on enable: *"MCP proxy for Claude Code when applicable"* â†’ *"direct use by all enabled agents"*.

---

## [1.0.64] â€” 2026-06-16

**Summary:** MCP telemetry is now stored per-project â€” KPI panel shows clean workspace-scoped data; cross-session intelligence still reads the global log.

**Theme:** Hybrid per-project MCP telemetry storage

### Added

- **`claudeSkills.telemetry.scope`** setting (`"workspace" | "global" | "hybrid"`, default `"hybrid"`) â€” controls where the efficiency KPI panel reads MCP telemetry from:
  - `hybrid` (default): workspace log when populated, global fallback â€” no data loss during migration
  - `workspace`: strict per-project isolation; KPIs never polluted by other projects
  - `global`: pre-1.0.64 behavior (single shared log)
- **Workspace-local MCP log** (`<workspace>/.claude/mcp-usage.jsonl`) â€” the bundled MCP filesystem server now dual-writes every tool call entry to both the global log (`~/.claude/learning/mcp-usage.jsonl`) and the workspace-scoped log, enabling accurate per-project attribution
- **`workspaceLogPath` in `allowed-dirs.json`** â€” extension writes the workspace log path into the server's config so the server can resolve the correct target path without restart
- **`workspaceMcpLogPath(workspaceRoot)` export** from `mcpUsageLog.ts` â€” utility for resolving the workspace log path used by the server and the extension

### Behavior changes

- **KPI panel** reads from `<workspace>/.claude/mcp-usage.jsonl` in hybrid and workspace modes (new sessions only â€” historical data stays in global log until the server writes to the workspace log)
- **Cross-session hot-file detection** always reads from the global log regardless of scope â€” preserving the cross-project signal that drives `mcp-agent-hints.md` optimization hints
- **MCP server** (long-running stdio process) re-reads `allowed-dirs.json` on each tool call, picking up the `workspaceLogPath` set by the extension without requiring a server restart

---

## [1.0.63] â€” 2026-06-16

This release completes the **AI Efficiency Engine** â€” a closed-loop system that combines MCP filesystem telemetry and transcript cost data to detect inefficiencies, quantify wasted tokens, and actively guide agent behavior via real-time alerts and optimization hints. The extension now not only tracks cost, but detects *why* tokens are wasted and proactively helps agents reduce it.

> **Two sources of truth:** Cost and token usage are derived from two complementary sources â€” `runs.jsonl` hook logs (ground truth for API usage and cost per skill invocation) and `mcp-usage.jsonl` MCP telemetry (execution behavior and estimated token inefficiencies from file access patterns).

### Added

- **Token quality KPI bar** in the efficiency panel â€” a stacked horizontal bar
  shows useful vs. wasted MCP tokens at a glance, with a colour-coded legend and
  three stat pills: *Total MCP reads*, *Wasted*, *Cost of waste* (~$X at Sonnet
  input rate). When recent sessions are available, also shows wasted tokens as a
  percentage of total API tokens.
- **Real-time efficiency alert** (`kpiAlert.ts`) â€” evaluated on every
  workspace-state refresh cycle; shows a VS Code notification when the MCP
  efficiency score crosses a threshold:
  - **Critical** (<40% efficiency or agent loop with >5 k wasted tokens) â†’
    `showWarningMessage`.
  - **Warning** (40â€“60%) â†’ `showInformationMessage`.
  - Minimum session size: 1 000 MCP tokens (silences noise from tiny runs).
  - Three action buttons: **View Details** (opens Cost Intelligence dashboard),
    **Auto-optimize** (writes `mcp-agent-hints.md` immediately and shows a
    confirmation with issue count), **Dismiss**.
- **Per-issue-type + per-session alert deduplication** â€” each distinct issue
  type (`loop`, `high-waste`, `low-efficiency`) fires at most once per MCP
  session (keyed by the server-side `sessionId`; falls back to calendar date for
  legacy logs without session IDs). Different problems in the same session each
  surface independently; the same problem does not repeat.
- **`sessionId` in MCP log entries** â€” the bundled filesystem server now rotates
  a 12-character UUID on each `initialize` handshake. Every subsequent log entry
  carries that ID, enabling per-conversation attribution without any env-var
  wiring. Legacy entries without a `sessionId` continue to work via date bucketing.
- **Cross-session hot-file detection** (`summarizeCrossSessionPatterns`) â€” groups
  14- to 30-day MCP read logs by `sessionId` and surfaces files read in >50% of
  sessions as *persistent hot spots* in a dedicated panel. Falls back to
  date-bucketed grouping for pre-`sessionId` logs.
- **`latestSessionId` in `McpUsageSummary`** â€” the most recent session ID found
  in the filtered log window is exposed so consumers (e.g. the alert system) can
  key deduplication on the actual agent conversation rather than wall time.
- **`totalWastedTokens` in `McpUsageSummary`** â€” aggregate of redundant-read
  tokens (waste warnings) plus loop re-read tokens (agent loops), summed without
  double-counting (loop-overlapping files are excluded from the waste-warnings
  total).
- **Efficiency formula tooltip** â€” the Efficiency stat pill in the HTML dashboard
  now has a `title` attribute explaining the calculation: *(useful ops) / (total
  ops)*, where wasteful ops include redundant reads, read-after-writes, loop reads,
  and no-op writes.
- **Dollar savings pill** â€” when suggestions carry `estimatedSavedTokens`, a
  *Potential saving* pill appears in the score banner (e.g. `~$0.069 saveable`).
- **Persistent hot-files panel** in the efficiency HTML dashboard â€” lists files
  found in >50% of sessions over 30 days with session count, prevalence %, and
  average reads per session. Links to a recommendation to add them to the
  permanent cache rules in `mcp-agent-hints.md`.
- **Auto-enable filesystem MCP server at startup** â€” 5 s after activation, if no
  AI agent has the filesystem server configured, it is silently enabled for all
  agents in `claudeSkills.agents.enabled`. Non-fatal; user can still disable via
  the command palette.

### Fixed

- **Duplicate waste/loop warnings** â€” files already flagged as agent loops are
  now excluded from the *Repeated reads* list. Previously the same file could
  appear in both sections.
- **Windows 8.3 short paths** (`SERHII~1` etc.) â€” all detection functions
  (`detectWaste`, `detectReadAfterWrite`, `detectAgentLoops`, `detectLargeFiles`)
  now receive path-resolved entries. `resolvePath()` calls `fs.realpathSync` with
  a safe fallback, so paths like `C:\Users\SERHII~1\...` and
  `C:\Users\SerhiiVoinolovich\...` are treated as the same file.
- **`MCP_SESSION_ID` env var** â€” removed the non-working env-var approach. Session
  IDs are now generated inside the server on each `initialize` call, which works
  regardless of how the server process is launched.
- Stale comment on `McpUsageEntry.sessionId` updated to reflect the actual
  implementation.
- `autoEnableFilesystemServer` setTimeout now guards against the workspace being
  closed before the 5 s timer fires.

### Changed

- `kpiAlert.ts` auto-optimize action now calls `writeMcpHints` directly (injecting
  the hints file immediately) rather than delegating to the efficiency-report
  command. The confirmation message includes the count of issues documented.
- Efficiency score deduplication upgraded from one-per-severity-per-day to
  one-per-issue-type-per-session, allowing multiple distinct problems to each
  surface once without spam.

### Refactored

- `computeScore` nested ternary extracted into `scoreToGrade()` function
  (SonarQube S3358 / cognitive complexity).
- Main accumulation loop in `summarizeMcpUsage` extracted into
  `accumulateEntries()` (SonarQube S3776 â€” complexity reduced from 16â†’15).
- In-place `.sort()` chains replaced with spread-then-sort on a separate
  statement throughout `mcpUsageLog.ts` (SonarQube S4043 â€” prevents accidental
  array mutation).
- `detectAgentLoops` inner `for (let i = 0; ...)` converted to `for...of`
  (SonarQube S4138).
- Consecutive `lines.push()` calls in `writeMcpHints` consolidated into
  multi-argument `push` calls (SonarQube S7778).

---

## [1.0.62] â€” 2026-06-16

### Added

- **Efficiency metrics panel** in the Cost Intelligence dashboard â€” four sub-panels
  showing cost per task (session), cost per skill run (avg $/invoke), cost per agent,
  and cost per file (MCP access frequency + estimated tokens). Panel only renders when
  data exists; hidden otherwise.
- **MCP usage log** (`~/.claude/learning/mcp-usage.jsonl`) â€” the bundled filesystem
  MCP server now appends one JSONL entry per tool call: `{ ts, tool, path, durationMs,
  bytes?, contentHash?, skipped? }`. `bytes` is recorded for `read_file` and
  `write_file` to enable downstream token-waste estimation.
- **Waste detection engine** in `mcpUsageLog.ts` â€” five independent detectors run on
  every dashboard open:
  - *Repeated reads*: same file read â‰¥3Ã— â†’ estimates wasted tokens (file size Ã— redundant reads Ã· 4).
  - *Agent loops*: same file read â‰¥4Ã— within a 5-minute sliding window â€” flags probable
    reasoning loops.
  - *Read-after-write*: `write_file` followed by `read_file` on the same path within 60 s.
  - *Large files*: any `read_file` result > 100 KB â€” suggests partial reads or `search_in_file`.
  - *No-op writes* (auto-skipped): `write_file` where new content matches existing file is
    silently skipped at the MCP server layer (`skipped: true` in log). Extension counts
    auto-saves.
- **Efficiency score** (0â€“100, Aâ€“F grade) â€” `(totalOps âˆ’ wastefulOps) / totalOps` computed
  from all active detectors and shown as a headline stat in the efficiency panel.
- **Auto-remediation hints file** (`~/.claude/learning/mcp-agent-hints.md`) â€” regenerated
  on every dashboard refresh with agent-readable rules derived from observed patterns
  (e.g., "do not re-read files already in context", cache list for hot files). Agents that
  read this file at session start receive cross-session optimization hints.
- **Efficiency report in output channel** â€” "Show Usage Stats" now appends a plain-text
  efficiency report (cost per skill/agent/task + MCP waste summary) to the Claude Skills
  output panel alongside the existing attribution and session breakdown sections.
- **No-op write auto-skip in MCP server** â€” `write_file` reads the existing file and computes
  a SHA-1 prefix of the new content; if they match, the write is skipped and `{ skipped: true }`
  is returned. Prevents redundant I/O and reduces attribution noise.

### Fixed

- `writeMcpHints`: added `mkdirSync` before `writeFileSync` so the hints file can be written
  even when `~/.claude/learning/` does not yet exist.

---

## [1.0.61] â€” 2026-06-16

### Added

- **Filesystem MCP Server** â€” bundled `index.js` MCP server gives Claude agents
  direct read/write access to `~/.claude/` and open workspace folders over
  JSON-RPC 2.0 stdio. Enable/disable via **Claude Skills: Enable/Disable Filesystem
  MCP Server** in the Command Palette; status is shown in the Claude Skills tree.
- **Allowed-directories security scope** â€” the server enforces an
  `allowed-dirs.json` allowlist (written to
  `~/.claude/mcp-servers/filesystem/allowed-dirs.json`). Only paths inside
  `~/.claude/` and the workspace folders open at enable-time are accessible.
  Path-traversal and sibling-directory access return a clear `Access denied` error.
- **Live allowlist reload** â€” when you open or close a workspace folder, the
  extension updates `allowed-dirs.json` in place; the running server picks up
  the new dirs on the next tool call without requiring a restart.
- **`refreshFilesystemAllowedDirs`** â€” internal export called from
  `onDidChangeWorkspaceFolders` to keep the allowlist in sync with the active
  workspace automatically.
- **Allowed dirs advertised at handshake** â€” the `initialize` response now
  includes `serverInfo.allowedDirs` so Claude can see its scope at the start of
  each session.

### Changed

- Notification text when enabling/disabling the filesystem MCP server changed
  from *"Restart Claude Desktop"* to *"Reload the VS Code window
  (Developer: Reload Window)"* â€” correct instruction for the VS Code extension
  context.
- `enableOfficialFilesystemServer` now accepts a `workspaceDirs: string[]`
  parameter and writes the allowed-dirs config before registering the server in
  `~/.claude.json`. The server is launched with `--config <allowed-dirs.json>`.

### Fixed

- costRates test updated to include the `cacheWrite1h` pricing field, fixing a
  test failure introduced when the field was added to the rate table.

---

## [1.0.60] - 2026-06-15

**Summary:** Filesystem MCP server status indicator added; tier downgrade reliably removes excess agent mirror folders; profile refresh no longer false-triggers cleanup.

**Theme:** Filesystem MCP status & Host-only tier cleanup fix

### Added

- **Filesystem MCP server connection status** â€” Claude Skills activity-bar tree shows whether the bundled filesystem server is configured in `~/.claude.json`
- MIT LICENSE file added to repository root; copyright holder name corrected

### Bug fixes

- **Tier cleanup gate** â€” prune uses `project-profile.json` on disk (`hostOnlyMirrorModeForTarget`) instead of stale in-memory `multiAgent` state
- **No recreate after prune** â€” `installSkillToAllWorkspaceAgents` respects host-only mirror targets (was fanning out to all enabled agents via profile-init and single-skill install)
- **Hook cleanup on downgrade** â€” removes extension-managed `claude-skills*` hooks under `.kiro/hooks` and `.github/hooks`, drops empty `.kiro/` when nothing remains; hook install respects host-only targets (no Kiro/Copilot re-install on solo-dev)
- **Profile-based host-only detection** â€” `solo-dev`, `budget-sensitive`, `solo-focused`, and `budget-focused` profiles trigger cleanup even when `multiAgent` is absent from disk
- **Broader tier triggers** â€” cleanup also runs on `multiAgent` flag change, `lockedTier` setting change, and feature toggle off; toast + output log when folders are removed
- **`tierChanged` detection** â€” treat missing `userPlan` as `accept-detected` and ignore partial `multiAgent` preset keys so signal-only refreshes do not trigger mirror cleanup; fixed a case where switching project tiers triggered redundant full-sync operations on the same session
- **Once-per-session-per-target guard** â€” added in `refreshAllImpl` â€” avoids duplicate refresh calls when a project profile resolves to host-only mirror mode on startup

---

## [1.0.59] - 2026-06-15

**Summary:** Solo-dev tier mirrors workspace skills to the running IDE only (Cursor/Kiro/Copilot), not all enabled agents.

**Theme:** Solo-dev host-only mirroring

### Behavior changes

- **Solo-dev mirroring** â€” when `claudeSkills.features.multiAgent` is off, workspace skill and learning sync targets only `detectHostAgentId()` (the IDE you have open), not Cursor + Kiro + Copilot together
- **Multi-agent unchanged** â€” when `multiAgent` is on, full fan-out to all enabled agents still applies
- **CLI parity** â€” `skills_sync.py` reads `agents.hostAgent` from `cli-config.json` (written by the extension) or `CLAUDE_SKILLS_HOST_AGENT`; use `--agents` to override headless sync
- **Tier downgrade cleanup** â€” manually choosing solo-dev or budget-focused removes auto-created `.cursor/`, `.kiro/`, and Copilot mirror folders except the running IDE; budget-focused also forces host-only mirroring on collaborative repos

---

## [1.0.58] - 2026-06-15

**Summary:** Task skill sets need user approval, respect a configurable confidence floor, and multi-agent mirroring requires multi-agent mode.

**Theme:** Task skill focus & multi-agent gating

### Behavior changes

- **Skill-set approval** â€” extension offers Focused / Workspace / Broader option sets; auto-apply and task focus wait until you pick **Choose Task Skill Set** or the startup quick pick
- **Minimum proposal confidence** â€” `claudeSkills.taskFocus.minProposalConfidence` (default 50) filters heuristics, drift refresh, usage report, and hooks; required platform skills stay exempt; generic tokens (`skill`, `skills`, `set`, â€¦) no longer inflate scores
- **Multi-agent mirroring** â€” Claude â†’ Cursor/Kiro/Copilot skill/learning mirror only when `claudeSkills.features.multiAgent` is on (removed solo-dev cost-discipline bypass)

---

## [1.0.57] - 2026-06-15

**Summary:** Close Claude VS Code attribution gap (PreToolUse workaround + dashboard warning) and auto-expand task focus when active skills go unused.

**Theme:** Attribution reliability & task skill focus

### Behavior changes

- **Claude VS Code gap detection** â€” scans `~/.claude/projects` transcripts for `claude-vscode` sessions with tool use but zero `PostToolUse` hook fires; dashboard hook panel shows warning and CLI/PreToolUse guidance
- **PreToolUse attribution workaround** â€” `installAttributionHooks` now registers `skill-invoke-watch.js` on both `PostToolUse` and `PreToolUse` in `.claude/settings.json` (anthropics/claude-code#27014); `skills_sync.py hooks install` parity
- **Task skill underuse promotion** â€” when task focus is on, a session has meaningful tool activity, and no active skill was invoked, high-confidence ignored skills from `task-skill-proposals.json` are promoted back into the active set (configurable under **Skill feedback**)

---

## [1.0.56] - 2026-06-14

**Summary:** Close cost-control gaps â€” stop installing budget hooks on attribution-only workspaces; align CLI hook file list and docs.

**Theme:** Cost control hook parity (hardening)

### Behavior changes

- `syncHooksOnSkillChange` refreshes cost-control scripts on all agent paths only when `costControlHooksActive()` (any Claude cost hook registered); attribution-only workspaces refresh attribution scripts only
- `skills_sync.py` `HOOK_FILES` includes `hookPlatform.js` and `task-skill-focus.js`; removed superseded per-hook task-drift installers

---

## [1.0.55] - 2026-06-14

**Summary:** Full four-agent cost-control hook parity â€” all five prompt hooks (budget, session size, context focus, practical focus, task drift) register and run on Claude, Cursor, Kiro, and Copilot.

**Theme:** Cost control hook parity

### Highlights

- **`hookPlatform.js`** â€” shared `resolveCwd`, `parsePlatform`, and per-agent `writePromptOutput` for Cursor `additional_context`, Kiro `additional_context`, Copilot `hookSpecificOutput`, and Claude `systemMessage` / `hookSpecificOutput`
- **All five hooks** â€” `installAgentCostControlPromptHooks()` registers session-size, budget, context-focus, practical-focus, and task-drift on Cursor `beforeSubmitPrompt`, Kiro `promptSubmit`, and Copilot `UserPromptSubmit`
- **Budget-watch fix** â€” resolves `workspace_roots` (not only `cwd`) and emits the correct output shape per agent; hook commands pass `cursor` / `kiro` / `copilot` argv
- **CLI parity** â€” `skills_sync.py hooks install --full` installs the same five hooks for all enabled agents
- **Hook status** â€” `getWorkspaceHookStatus()` checks Claude + agent mirror for each cost-control hook

### Behavior changes

- Re-run **Enable Cost Control Hooks** to add session-size / focus hooks on Cursor/Kiro/Copilot and refresh budget commands with platform args
- Session-size warnings still require `transcript_path` (Claude + Cursor); Kiro/Copilot hooks register but no-op without transcripts

---

## [1.0.54] - 2026-06-14

**Summary:** Fix Kiro `.kiro.hook` schema â€” use `promptSubmit` and `sessionStart` for `when.type` (Kiro rejects `userPromptSubmit` / `agentSpawn`).

**Theme:** Four-agent hook parity (Kiro schema compliance)

### Behavior changes

- Kiro budget and task-drift hooks now register `when.type: promptSubmit` instead of `userPromptSubmit`
- Kiro profile-init hook now registers `when.type: sessionStart` instead of `agentSpawn`
- Re-run **Enable Cost Control Hooks** or **Install Profile Init Session Hook** (or reload the workspace) to rewrite existing `.kiro/hooks/*.kiro.hook` files
- `profile-init-watch.js` still accepts legacy `agentSpawn` stdin events for backward compatibility

---

## [1.0.53] - 2026-06-14

**Summary:** Cost discipline pack â€” cap task skills at 8â€“12, bootstrap new branches with relevant subsets, budget tier gating, and weekly resolver for economy tiers.

**Theme:** Task focus & branch-local skill economy

### Highlights

- **Task skill focus cap** â€” `claudeSkills.taskFocus.maxActiveSkills` (default 12) limits active + proposed skills; required platform skills count toward the cap
- **Branch bootstrap** â€” new branches without a saved profile get infra/app heuristics + relevant-only install instead of inheriting main's full library
- **Budget tier gating** â€” high-tier skills outside the active task set auto-disable at 80% daily budget; medium-tier at 95%
- **Relevant install only** â€” prunes personal-local irrelevant skills when installs exceed 2Ã— the focus cap
- **Weekly resolver** â€” `skillSetResolver` tier feature enabled for `solo-dev` and `budget-sensitive`; unset `skillSetResolver.enabled` follows tier default
- **Four-agent parity** â€” cost discipline propagates to Cursor/Kiro/Copilot mirrors + Copilot bootstrap; budget-watch hooks on all four agents; learning artifacts mirrored to `.cursor/learning` / `.kiro/learning`
- **Host-first entry** â€” extension detects running IDE (`detectHostAgentId`); imports host mirror skills/learning into canonical `.claude/` when you never opened Claude Code first; per-IDE skill sets work on solo-dev tier in Cursor/Kiro/VS Code

### Behavior changes

- Switching to a new branch seeds a focused skill profile when branch bootstrap is on (profile init prompt still runs when enabled)
- Task proposals and focus ignore skills beyond the configured cap (extension + `task-skill-focus.js` hook)
- Cost discipline pass always runs host-first bootstrap, then fans out to non-Claude agents when `propagateToAllAgents` is on (default)
- Opening the extension in Cursor/Kiro/Copilot bootstraps `.claude/skills` and `.claude/learning` from the host mirror when canonical copies are missing
- `cli-config.json` includes `taskFocus` and `costDiscipline` blocks for headless hook parity

---

## [1.0.52] - 2026-06-14

**Summary:** Releases 1.0.45â€“1.0.51 are now parity-checked across Claude, Cursor, Kiro, and Copilot â€” task drift inject, session-start fallbacks, and transcript-based session-size drift for Cursor/Claude.

**Theme:** Four-agent hook parity for cost intelligence & skill adaptation

### Highlights

- **Task drift (1.0.51)** â€” `task-drift-watch.js` registered for all four agents: Claude `UserPromptSubmit`, Cursor `beforeSubmitPrompt`, Kiro `userPromptSubmit`, Copilot `UserPromptSubmit` / `userPromptSubmitted`
- **Session-start fallback** â€” `profile-init-watch.js` delivers pending task-drift prompts on Claude SessionStart, Cursor sessionStart, Kiro agentSpawn, and Copilot SessionStart (same path as 1.0.50 low-trust inject)
- **Session-size drift** â€” extension also reads Claude/Cursor transcript file sizes when evaluating task drift (Kiro/Copilot lack local transcripts per `agents.json`)
- **Attribution & costs (1.0.46â€“1.0.49)** â€” unchanged multi-agent PostToolUse hooks; General API panel remains Claude/Cursor transcriptâ€“based where transcripts exist
- **Per-skill cross-agent costs** â€” `buildCostAttribution` now uses measured hook `cost` from `runs.jsonl` (API usage breakdown) instead of re-estimating with a flat blended $/M rate â€” aligns Cross-agent panel with Usage Report **$X/run (API)** rows
- **Agent routing hint** â€” when daily budget is nearly exhausted, routing suggestion explains budget-driven Copilot fallback vs measured cheapest agent
- **claude-api lint** â€” trimmed SKILL/instructions frontmatter description to â‰¤500 chars (trigger/skip rules remain in body)

### Behavior changes

- Cross-agent **Per-skill** table and routing cost parentheses now match hook-measured costs (~$0.05/run with heavy cache read) instead of inflated blended estimates (~$0.30/run)
- **Suggested agent: copilot** during budget exhaustion now includes explicit "daily budget nearly exhausted" context

### Technical

- `hookOps.ts` â€” `installAgentTaskDriftHooks()` for Cursor/Kiro/Copilot; separate `.github/hooks/claude-skills-task-drift.json` and `.kiro/hooks/claude-skills-task-drift.kiro.hook`
- `taskDriftReproposal.ts` â€” merges `session-watch.json` with workspace Claude/Cursor transcript byte thresholds
- `skills_sync.py` â€” headless task-drift hook install when `hooks install --full`
- `costAttribution.ts` â€” `costForRunRecord()` prefers stored `rec.cost`; `formatAttributionReport` labels column **Cost** with hook vs estimate note
- `costRouter.ts` â€” `formatRoutingSuggestion()` budget context when cheapest agent differs from routed agent
- `.claude/skills/claude-api/SKILL.md`, `.github/instructions/claude-api.instructions.md` â€” short frontmatter description

---

## [1.0.51] - 2026-06-14

**Summary:** Task scope drift (off-profile skill use or large session) now auto-refreshes `task-skill-proposals.json`, re-applies task focus, and injects a one-time agent hint.

**Theme:** Reactive skill re-proposal when agents drift from the active task set

### Highlights

- **Feature** â€” `claudeSkills.features.taskDriftReproposal` (default on)
- **Triggers** â€” `not_in_active_profile` invokes in `runs.jsonl` (default â‰¥2) and/or session transcript at warn/critical (`session-watch.json`)
- **Settings** â€” `claudeSkills.skillFeedback.taskDriftMinOffProfileInvokes`, `taskDriftSessionSizeLevel`, `taskDriftCooldownMinutes`, `taskDriftNotifyUser`
- **Hook** â€” `task-drift-watch.js`: Claude Code `UserPromptSubmit` + Cursor `beforeSubmitPrompt` inject refreshed active skill list once per drift event (Kiro/Copilot added in **1.0.52**)
- **State files** â€” `.claude/learning/task-drift-reproposal.json`, `task-drift-prompt.json`

### Behavior changes

- Extension refresh cycle evaluates drift before normal deterministic proposal refresh; cooldown prevents rapid re-proposal loops (default 30 min)
- Off-profile skills used by the agent are boosted into the refreshed proposal set with high confidence
- `applyTaskProposalsIfPending` still auto-installs/enables when `autoApplyTaskProposals` is on

### Technical

- `taskDriftReproposal.ts` â€” detection, heuristic refresh, focus re-apply, prompt snapshot
- Cost-control hook install now registers `task-drift-watch.js` alongside session-size and context-focus hooks

### Known gaps (addressed in 1.0.52)

- ~~**Kiro / Copilot** â€” mid-session agent inject~~ â†’ wired in 1.0.52
- **Heuristic refresh** â€” extension re-seeds proposals from workspace heuristics; agent refinement via `skill-feedback-adaptation` section 3 is still optional after drift inject
- **General API spend (1.0.49)** â€” Kiro/Copilot have no local transcript roots; panel uses Claude/Cursor session data only

---

## [1.0.50] - 2026-06-14

**Summary:** Low cost-attribution trust now triggers a silent SessionStart hint to agents (configurable threshold, default 50%).

**Theme:** Agent awareness when cost data is unreliable

### Highlights

- **Settings** â€” `claudeSkills.costIntelligence.lowTrustPromptEnabled` and `lowTrustPromptThresholdPct` (0â€“100)
- **SessionStart hook** â€” when trust score is below threshold, agents receive grounding not to rely on per-skill cost rankings
- **Snapshot file** â€” `.claude/learning/attribution-trust.json` updated on dashboard refresh

### Technical

- `attributionTrustConfig.ts` syncs trust score from `assessAttributionHealth` + `buildGlobalTrustBadge`
- `profile-init-watch.js` appends low-trust context on Claude, Cursor, Kiro, and Copilot session start

---

## [1.0.49] - 2026-06-14

**Summary:** Cost dashboard now shows **General API** spend â€” base-model session work and residuals not attributed to listed skill invokes.

**Theme:** Non-skill agent usage visibility

### Highlights

- **General API Â· 14d** panel â€” transcript session totals minus hook-measured skill invokes; covers agents answering from built-in knowledge without reading a listed skill
- **Overview stat** â€” **General API** pill alongside **Skill spend** and session totals
- **Collector fix** â€” routes non-skill sessions to `base_context` instead of inflating legacy `unattributed`
- **Hook metadata** â€” `not_in_active_profile: true` when a skill file is read outside the active task/profile set

### Technical

- `generalApiSpend.ts` â€” `computeGeneralApiSpend()`, session residual helpers
- `applyTranscriptAttribution()` â€” hook sessions: `session_tokens âˆ’ hook_tokens`; no-skill sessions: full session â†’ `base_context`
- Legacy `unattributed` bucket flagged for reset when pre-1.0.49 data dominates

---

## [1.0.48] - 2026-06-14

**Summary:** Cost dashboard **Models by agent** now shows API-priced **Skill invokes** rows from attribution hooks for Cursor (and other agents) â€” not only the transcript size estimate.

**Theme:** Hook-measured models in per-agent breakdown

### Highlights

- **Models by agent** â€” prepends **Skill invokes (cursor)** (and per-model ids when logged) from `runs.jsonl` before **cursor-agent (size est.)** transcript proxy
- **Panel note** â€” explains transcript size estimate vs hook API rows
- **Agent credit usage** â€” same hook merge for status-bar / overview model breakdown

### Technical

- `aggregateHookModelUsageByAgent()` and `mergeHookModelsIntoAgentRows()` in `usageCost.ts`
- `computePerAgentCreditUsage()` merges hook models when workspace target is set
- Unit test for Cursor hook model aggregation

---

## [1.0.47] - 2026-06-14

**Summary:** Skills tree, status bar, and usage report show API-priced costs from real hook usage when available â€” not blanket "Est." labels.

**Theme:** Measured cost labels everywhere hooks fire

### Highlights

- **Skills library tree** â€” `$X/session (API)` from measured `runs.jsonl` cost; `(catalog)` only when no runs logged
- **Status bar** â€” `API` / `Mixed` / `Est.` prefix based on whether today's transcripts include usage metadata
- **Usage report** â€” **Cost/run** column with API vs logged basis per skill
- **Dashboard overview** â€” **Session spend** when transcripts have full API usage lines

### Technical

- Per-skill stats aggregate `totalCost`, `avgCostUsd`, and `measuredRuns` from hook rows
- ROI/confidence upgrades when `usage_breakdown` metadata is present
- Dashboard top-skill rows show **API-priced (hooks)** trust label when usage breakdown is present

---

## [1.0.46] - 2026-06-14

**Summary:** Cost dashboard and CLI now show real per-skill spend from hook invocations at published API rates â€” not inflated transcript equal-split estimates.

**Theme:** Accurate skill-level cost attribution

### Highlights

- **Top skills Â· measured** â€” dashboard ranks skills from `runs.jsonl` hook/self-learning rows with input/output/cache pricing per model
- **Skill spend** overview stat â€” separate hook-grounded total in the 14-day Overview panel
- **Model-aware pricing** â€” Fable/Mythos/Opus/Sonnet/Haiku tiers; API vs size-estimate labels on agent model rows
- **Python CLIs** â€” `scripts/skill_cost_from_runs.py` (per-skill from logs) and `scripts/agent_billing_report.py` (Anthropic/Cursor/Copilot admin APIs)

### Behavior changes

- Attribution-collector transcript rows are excluded from per-skill cost totals (fixes inflated $1k+ weekly figures)
- Equal-split mis-attribution no longer drives **Top skills** when v2 hook runs exist
- Weekly report and `cost_intelligence.py` skip collector rows when summing skill spend

### Technical

- New `skillCostFromRuns.ts`, `runs_cost.py`, `agent_billing.py`; hook writes `metadata.usage` + `cost_method: usage_breakdown`
- `normalizeRunRecord` reads `metadata.model` for usage-based cost recompute

---

## [1.0.45] - 2026-06-14

**Summary:** Weekly email leads with real extension benefits from your logs; manual tier changes work from the status bar and stick reliably.

**Theme:** Benefits visibility & tier control fixes

### Highlights

- **Weekly benefits report** â€” email opens with tier savings, skill success rates, hook-tracked invocations, and cross-agent savings from `runs.jsonl` + `project-profile.json`
- **Status bar tier badge** opens **Choose Project Profile Tier** directly (not a read-only summary)
- **Tier lock** derives from your chosen plan (`solo-focused` etc.), not a stale `profileType` on disk
- **Settings `lockedTier`** syncs to `project-profile.json` when no explicit user plan is set

### Behavior changes

- After choosing a tier, a confirmation toast always appears (not gated by `notificationLevel`)
- **Show Project Tier** still offers **Change tier** via a standard information message
- Default weekly email subject: **Weekly Claude Skills Benefits Report**

### Technical

- New `weeklyReportBenefits` module; publish workflow skips missing registry secrets gracefully (Node 22)

---

## [1.0.44] - 2026-06-14

**Summary:** Stays out of your way â€” quieter notifications, no terminal hijack, tier lock that sticks, and silent self-updates from Open VSX.

**Theme:** Quiet operations & reliable tier control

### Highlights

- **Minimal notifications** by default â€” background auto-apply and suggestions log to Output instead of toasting
- **Output panel stays hidden** unless you ask (`revealOutputPanel` off by default; new **Show Output Log** command)
- **Silent extension auto-update** checks Open VSX every 6 hours and installs newer releases without prompts
- **Manual tier lock** prefers your on-disk plan over stale workspace settings; **solo-focused** plan overrides team detection on shared repos

### Behavior changes

- Locked tiers no longer spam "tier changed" when you already chose a plan
- First-run welcome and setup wizards skipped unless `notificationLevel` is **normal**
- `silent` notification level auto-accepts detected tier (no QuickPick on first open)
- Tier benefit benchmark (`npm run bench:tier-benefits`) and cross-platform skill-impact bench on Windows

### Configuration

- `claudeSkills.notificationLevel` â€” `minimal` (default), `silent`, or `normal`
- `claudeSkills.revealOutputPanel` (default off)
- `claudeSkills.autoUpdateExtension` (default on)
- `claudeSkills.autoUpdateExtensionHours` (default 6)

### Technical

- `userNotify` module centralizes toast gating; CI vscode mock fixes for `Uri`/`inspect`
- `extensionAutoUpdate` pulls latest VSIX from Open VSX with gallery fallback

---

## [1.0.43] - 2026-06-14

**Summary:** More accurate team-tier detection for fresh clones â€” uses remote Git signals, not just your local checkout.

**Theme:** Remote-aware tier intelligence

### Highlights

- Choosing a tier now probes `origin` with plain `git` commands (extension-only â€” no AI agent involved)
- Fresh clones of busy team repos can be detected as **TEAM MULTI-AGENT** even with one local branch
- Remote branch and author counts feed the same plan picker you already use

### Behavior changes

- Tier detection considers **remote** repo activity (`max(local, remote)` branches and authors)
- **Detect Project Profile** and **Choose Project Profile Tier** probe origin before recommending a tier
- Accepting the detected tier keeps remote-probed signals (no silent revert to local-only metrics)

### Configuration

- `claudeSkills.projectProfile.probeRemoteGit` (default on)
- `claudeSkills.projectProfile.remoteProbeTimeoutMs` (default 8000 ms)

### Technical

- `git ls-remote`, remote-tracking refs, upstream ahead/behind; cached **1 hour** in `.claude/learning/remote-repo-probe.json`

---

## [1.0.42] - 2026-06-14

**Summary:** Compare tier plans with estimated savings before you commit â€” and manual tier changes finally stick.

**Theme:** Project tiering & cost optimization

### Highlights

- Every plan in the tier picker shows estimated monthly overhead and savings vs full stack
- Comparison table logged before you pick (all 5 tiers side-by-side)
- Switch tiers any time to explore what solo vs multi-agent actually costs

### Behavior changes

- Explicit plan choices (including throwaway and enterprise) **lock** the tier â€” auto-detect no longer overwrites your pick
- Saved `manualOverride` is respected even when `lockedTier` is empty in settings

### UX

- **Show Project Tier** and **Choose Project Profile Tier** display economics per option
- **View details** action after confirming a plan

---

## [1.0.41] - 2026-06-14

**Summary:** Tier detection driven by real repo activity (git history, branches, files) â€” and the first-open dialog asks about your *plans*, not a tier catalog.

**Theme:** Project tiering & cost optimization

### Highlights

- Git-first detection: commits, authors, branches, repo size, and age â€” not just "which AI folders exist"
- **AIDLC greenfield** plan: solo developers on AI-DLC can get multi-agent tier from day one
- Plans prompt: AIDLC, multi-agent workflow, team product, budget, quick spike, or accept detected

### Behavior changes

- New git repos default to **solo-dev** (not throwaway) unless multi-agent or AIDLC signals are present
- First-open plans dialog no longer skipped on new workspaces (prompt state fix)

### UX

- Status bar tooltip, cost dashboard, and output channel show git analysis evidence

---

## [1.0.40] - 2026-06-14

**Summary:** New projects get asked how you plan to use AI agents â€” instead of silently landing on solo-dev.

**Theme:** Project tiering & cost optimization

### Highlights

- First-open **QuickPick** on projects without `.claude/learning/project-profile.json`
- Picking multi-agent / budget / enterprise locks the tier so auto-detect does not revert later

### Behavior changes

- Onboarding tour step 1 now routes through project profile selection before skill install

### Configuration

- `claudeSkills.projectProfile.promptOnFirstDetect` (default on)

---

## [1.0.39] - 2026-06-14

**Summary:** Your project tier is visible everywhere â€” status bar, dashboard, and notifications â€” with estimated savings.

**Theme:** Project tiering & cost optimization

### Highlights

- Status bar badge: `TEAM MULTI-AGENT`, `SOLO DEV`, `BUDGET-SENSITIVE`, etc.
- Cost dashboard **Project tier** panel: detected type, overhead, savings, feature list
- Toast when tier changes with **View details** / **Change tier** actions

### UX

- Command: **Show Project Tier** â€” full breakdown in output channel

---

## [1.0.38] - 2026-06-14

**Summary:** The extension auto-configures CPU and token spend per project â€” solo, team, budget, enterprise, or throwaway.

**Theme:** Project tiering & cost optimization (v1)

### Highlights

- Automatic project tier detection with feature presets (multi-agent sync, attribution, cost intel, session adapt)
- Writes `.claude/learning/project-profile.json` per workspace
- Throwaway/script projects skip heavy background work automatically

### Behavior changes

- When `applyTierFeatures` is on, tier presets override `claudeSkills.features.*` for this workspace
- Cost pipeline skipped when both `costIntelligence` and `attributionCollector` are off (throwaway tier)
- Profile re-detect throttled to **24 hours** unless tier or signals change

### Configuration

- `claudeSkills.projectProfile.autoDetect`, `applyTierFeatures`, `lockedTier`

### Commands

- **Detect Project Profile**, **Choose Project Profile Tier**

---

## [1.0.37] - 2026-06-14

**Summary:** Full benchmark suite for proving performance and skill-impact claims before release.

**Theme:** Benchmarks & release quality

### Highlights

- `npm run bench:complete` â€” hot paths, cost pipeline, hooks, adaptation, CI/ADX harness with SLA checks
- `npm run bench:skill-impact` â€” Claude CLI A/B with vs without skills; cost and token diffs

### Tooling

- Complex agent fixture (`agent-comparison-fixture-complex/`) with ADX KQL grader
- `resolve-library-dir.mjs`, `installed-extension-path.mjs` for reliable local benchmarks
- Install smoke no longer hardcodes extension version

### Docs

- `COMPLETE-BENCHMARK-GUIDE.md` â€” `bench:complete` vs `bench:skill-impact`

---

## [1.0.36] - 2026-06-14

**Summary:** Git commands hardened against shell injection â€” safer on untrusted workspace paths.

**Theme:** Security hardening

### Security

- `branchProfiles.ts` and `skillOps.ts` use `execFileSync("git", [...])` with argument arrays instead of shell string interpolation

---

## [1.0.35] - 2026-06-14

**Summary:** Cost dashboard loads from cache in milliseconds â€” team economics precomputed in the background.

**Theme:** Dashboard & cache performance

### Performance

- **Dashboard warm read:** **< 5 ms** from `.claude/learning/dashboard-snapshot.json`
- **Cold render target:** **< 30 ms** (fast-phase disk read ~1 ms)
- **Team economics cache:** persistent `.claude/learning/team-economics-cache.json`; warm reads **< 5 ms**

### UX

- Progressive injection: loading slots first, then main + team panels via webview `postMessage`
- Background precompute after cost pipeline sync

---

## [1.0.34] - 2026-06-14

**Summary:** Cost dashboard went from ~7 seconds to ~200 ms â€” a **97%** improvement for daily use.

**Theme:** Dashboard & cache performance

### Performance

- **Dashboard load time:** ~7 s â†’ ~**200 ms** (~**97%** faster)
- Git blame author lookups cached by `SKILL.md` mtime
- Single `attributeCostToAuthors` pass per render (was double)
- Skill detection: faster glob filtering + expanded exclude dirs (`.vscode-test`, `dist`, `out`, `build`, â€¦)

### Efficiency

- No duplicate cost pipeline run when opening dashboard
- Runs index rebuild skipped when indexes are already fresh
- Tree view skips `computeUsageStats` when cost-aware search is off

---

## [1.0.33] - 2026-06-14

**Summary:** Sync engine overhaul â€” no more UI jank when toggling skills or mirroring to Cursor/Kiro/Copilot.

**Theme:** Sync engine stability & concurrency

### Highlights

- Chunked async fan-out: agent sync yields between each agent (eliminates burst jank)
- Predictive pre-sync fingerprint: rapid on-off toggles before debounce flushes are skipped silently
- Activity-aware interaction lock: sync pauses while you type, click, or run commands

### Performance targets

- `toggle-ui` **< 16 ms** Â· `tree-refresh` **< 10 ms** Â· sync **< 150 ms** (p50/p95/p99 logged)

### UX

- Toggle ripple: 130 ms green check flash on checkbox
- Lock-free runs reads; size-stable hash reuse across Windows git-checkout mtime drift

### Planned (v1.1)

- Worker thread for cost pipeline + JSONL aggregation

---

## [1.0.32] - 2026-06-14

**Summary:** Smoother skill toggles â€” background sync waits until you stop interacting.

**Theme:** Sync engine stability & concurrency

### Highlights

- Interaction lock (800 ms / 1.5 s quiet window) during typing and clicking
- Granular tree refresh: per-skill updates with cached `SkillItem` instances
- Parallel agent fan-out on separate event-loop turns

### Added

- `runs.snapshot.json` v2 with `version`, `lastUpdated`, `sourceSize`, `sourceMtimeMs`
- Perf telemetry via `recordPerf` / `CLAUDE_SKILLS_PERF=1`

---

## [1.0.31] - 2026-06-14

**Summary:** Smarter debouncing â€” fast response when you act, quiet coalescing in the background.

**Theme:** Sync engine stability & concurrency

### Highlights

- User actions flush at **400 ms**; background watchers coalesce at **1200 ms**
- Optimistic skill tree: checkbox updates instantly; mirrors sync in background
- Agent-diff sync: only the toggled skill mirrors to other agents (not full workspace)

### Added

- `runs.snapshot.json` for instant cold load of usage dashboard data
- Cache warmup 1 second after activate

---

## [1.0.30] - 2026-06-14

**Summary:** Foundation of the modern sync architecture â€” hash-based copies, coalesced queues, lazy startup.

**Theme:** Sync engine stability & concurrency

### Highlights

- Hash-based agent sync: copy only when content differs
- Workspace sync queue: **2 second** coalesced merges for rapid watcher events
- Lazy activation: light refresh on startup; deferred agent sync after **3 seconds**

### Efficiency

- Incremental `runs.jsonl` cache: append-only tail reads
- Fingerprint skip when effective skills and hashes unchanged

---

## [1.0.29] - 2026-06-14

**Summary:** See which AI agent (Claude, Cursor, Kiro, Copilot) used which skills â€” and trim token load automatically.

**Theme:** Multi-agent visibility & automation

### Highlights

- Cross-agent usage matrix in Usage Report and weekly email
- Task skill focus: non-proposed skills set `off` after auto-apply to save tokens
- Deterministic profile init and task proposals without an agent session

### Performance

- Manifest/skill-status/detection caches; coalesced workspace refresh

---

## [1.0.28] - 2026-06-13

**Summary:** Integration smoke test in CI â€” extension activation verified before every publish.

**Theme:** Release quality & session hooks

### Highlights

- `@vscode/test-electron` integration smoke (`npm run test:integration`)
- NEW SESSION task-proposal hook on all four agent platforms
- Weekly batch release policy documented in `PUBLISHING.md`

---

## [1.0.27] - 2026-06-13

**Summary:** Proposed skills auto-install when `task-skill-proposals.json` updates â€” no manual apply step.

**Theme:** Session automation

### Behavior changes

- `autoApplyTaskProposals` (default on): installs and enables every skill in **Proposed for current task**
- Session skill apply no longer caps at 20 skills when merging profile + proposals

---

## [1.0.26] - 2026-06-13

**Summary:** Full headless Claude CLI workflow â€” apply skills, sync branch profiles, install hooks without VS Code open.

**Theme:** Headless CLI & hooks

### Highlights

- `skills_sync.py` + `generate_skills.py`: `apply-session`, `apply-profile`, `sync-branch`, `sync-agents`, `hooks install`
- **Prepare for Claude CLI** command â€” one-click setup
- `.claude/learning/cli-config.json` mirrors IDE feature toggles for CLI/hooks

---

## [1.0.25] - 2026-06-13

**Summary:** Skills follow you into every new agent session â€” Cursor, Kiro, Copilot, and Claude Code.

**Theme:** Multi-agent session automation

### Highlights

- Session skill adaptation: auto-install/enable from profile and task proposals on each new session
- Profile-init hooks for Cursor, Kiro, and GitHub Copilot (not just Claude)

### Fixed

- Per-IDE profile-init skill sets saved for the correct host agent
- Open VSX publish packages current version (not stale VSIX)

---

## [1.0.24] - 2026-06-13

**Summary:** Reliable installs on Windows even when agents lock hook files open.

**Theme:** Windows stability

### Fixed

- EBUSY retry with backoff on hook/skill copies
- Install completes with warning if post-install hook sync fails (does not abort)
- Quieter startup sync: propagate only when mirrors are missing or stale

---

## [1.0.23] - 2026-06-13

**Summary:** SKILL lint no longer false-alarms on Windows CRLF or economy-disabled skills.

**Theme:** Developer experience

### Fixed

- Frontmatter parser handles CRLF and YAML block-scalar descriptions
- Copilot mirror lint respects `skillOverrides: off`

---

## [1.0.22] - 2026-06-13

**Summary:** Different skill sets per IDE and per git branch â€” Cursor, Kiro, Copilot, Claude Code.

**Theme:** Per-IDE skill profiles

### Highlights

- Save and switch skill sets per branch per IDE (`~/.claude/learning/agent-skill-profiles.json`)
- Auto-apply on workspace open when a saved set exists

---

## [1.0.21] - 2026-06-13

**Summary:** Extension available on Open VSX â€” install in Cursor and Kiro IDE, not only VS Marketplace.

**Theme:** Distribution

### Highlights

- `npm run publish:openvsx` + GitHub Actions **Publish Extension** workflow
- `cursor-kiro-extension-publishing` skill for agent-guided publish

---

## [1.0.20] - 2026-06-13

**Summary:** Skills learn from your feedback â€” and the extension suggests better skills when spend spikes.

**Theme:** Skill feedback & lifecycle

### Highlights

- `skill-feedback-adaptation` skill: disagreement logging + task proposals
- High token usage popup when branch/task exceeds **50%** of monthly credits (configurable)
- Skill versioning in manifest: outdated alerts + **Upgrade Outdated Skills**
- Attribution trust badge: Reliable / Estimated / Low confidence

---

## [1.0.19] - 2026-06-12

**Summary:** Confidence scores everywhere â€” and the optimizer reacts in real time after each cost sync.

**Theme:** Cost intelligence depth

### Highlights

- Trust banner and per-skill confidence (`high` / `estimated` / `low`) on Usage Report
- `autoDetectOnPipeline` (default on): debounced auto-optimize ~5 seconds after pipeline sync
- In-memory runs + transcript indexes avoid full re-parses

---

## [1.0.18] - 2026-06-12

**Summary:** Attribution you can trust â€” Cursor hooks fixed, pipeline resilient, dashboard faster to read.

**Theme:** Attribution & pipeline resilience

### Highlights

- Expanded skill path detection for Cursor (`.cursor/skills-cursor/`, `skills_library/`, `.agents/skills/`)
- Circuit breaker: trips after >10 pipeline runs/minute; forces safe mode
- CSP-safe webviews; shared compact dashboard chrome

### Behavior changes

- `runs.jsonl` scope narrowed to v2 hook invocations + self-learning (transcript estimates stay in `cost-attribution.json`)
- **Reset Mis-attributed Cost Data** command for legacy cleanup

---

## [1.0.17] - 2026-06-12

**Summary:** ROI and trust layers on cost data â€” see dollars saved, not just dollars spent.

**Theme:** FinOps foundation

### Highlights

- Per-skill ROI bands (`HIGH` / `MEDIUM` / `LOW`) with time-saved heuristics
- Value panel: minutes saved, dollar value, net ROI in Cost Intelligence Dashboard
- Unified system state: `.claude/learning/system-state.json`

---

## [1.0.1] - 2026-06-12

Same content as consolidated **1.0.0** below â€” first publishable Marketplace version after 1.0.0 was already taken.

---

## [1.0.0] - 2026-06-12

**Summary:** First production release â€” bundled skills, four-agent sync, profile init, and cost intelligence.

**Theme:** Foundation

### Highlights

- Bundled skill library with stack detection (`manifest.json` + `detect_globs`)
- Multi-agent deploy: Claude Code, Cursor, Kiro, GitHub Copilot
- Profile init on new branches (agent-driven skill selection by role)
- Cost Intelligence Dashboard, budget modes, attribution collector
- Activity bar Skills tree, setup wizard, onboarding tour

### Requirements

- VS Code / Cursor **1.85+**; optional `vscode.git` and GitHub CLI
