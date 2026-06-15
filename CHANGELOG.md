# Changelog

All notable changes to **Claude Skills Manager** (VS Code extension) are documented here.

Consolidated release line starts at **1.0.1** (2026-06-12). **1.0.60** is the current Marketplace publish target.

## How to read this log

Each release includes:

- **Summary** — what changed for *you* in one line
- **Theme** — the strategic wave that release belongs to
- **Highlights** — demo-friendly bullets (when the release is substantial)
- **Behavior changes** — things that may change what you see day-to-day

### Product evolution (release waves)

| Versions | Theme |
|----------|--------|
| **1.0.38 – 1.0.52** | Project tiering & cost optimization |
| **1.0.34 – 1.0.35** | Dashboard & cache performance |
| **1.0.30 – 1.0.33** | Sync engine stability & concurrency |
| **1.0.36** | Security hardening |
| **1.0.37** | Benchmarks & release quality |
| **1.0.17 – 1.0.29** | Cost intelligence, multi-agent, CLI headless |
| **1.0.0 – 1.0.16** | Foundation — skills, agents, profile init |

---

## [1.0.60] - 2026-06-15

**Summary:** Tier downgrade reliably removes excess agent mirror folders; profile refresh no longer false-triggers cleanup.

**Theme:** Host-only tier cleanup fix

### Bug fixes

- **Tier cleanup gate** — prune uses `project-profile.json` on disk (`hostOnlyMirrorModeForTarget`) instead of stale in-memory `multiAgent` state
- **No recreate after prune** — `installSkillToAllWorkspaceAgents` respects host-only mirror targets (was fanning out to all enabled agents via profile-init and single-skill install)
- **Broader tier triggers** — cleanup also runs on `multiAgent` flag change, `lockedTier` setting change, and feature toggle off; toast + output log when folders are removed
- **`tierChanged` detection** — treat missing `userPlan` as `accept-detected` and ignore partial `multiAgent` preset keys so signal-only refreshes do not trigger mirror cleanup

---

## [1.0.59] - 2026-06-15

**Summary:** Solo-dev tier mirrors workspace skills to the running IDE only (Cursor/Kiro/Copilot), not all enabled agents.

**Theme:** Solo-dev host-only mirroring

### Behavior changes

- **Solo-dev mirroring** — when `claudeSkills.features.multiAgent` is off, workspace skill and learning sync targets only `detectHostAgentId()` (the IDE you have open), not Cursor + Kiro + Copilot together
- **Multi-agent unchanged** — when `multiAgent` is on, full fan-out to all enabled agents still applies
- **CLI parity** — `skills_sync.py` reads `agents.hostAgent` from `cli-config.json` (written by the extension) or `CLAUDE_SKILLS_HOST_AGENT`; use `--agents` to override headless sync
- **Tier downgrade cleanup** — manually choosing solo-dev or budget-focused removes auto-created `.cursor/`, `.kiro/`, and Copilot mirror folders except the running IDE; budget-focused also forces host-only mirroring on collaborative repos

---

## [1.0.58] - 2026-06-15

**Summary:** Task skill sets need user approval, respect a configurable confidence floor, and multi-agent mirroring requires multi-agent mode.

**Theme:** Task skill focus & multi-agent gating

### Behavior changes

- **Skill-set approval** — extension offers Focused / Workspace / Broader option sets (`claudeSkills.taskFocus.approveSkillSets`, default on); auto-apply and task focus wait until you pick **Choose Task Skill Set** or the startup quick pick
- **Minimum proposal confidence** — `claudeSkills.taskFocus.minProposalConfidence` (default 50) filters heuristics, drift refresh, usage report, and hooks; required platform skills stay exempt; generic tokens (`skill`, `skills`, `set`, …) no longer inflate scores
- **Multi-agent mirroring** — Claude → Cursor/Kiro/Copilot skill/learning mirror only when `claudeSkills.features.multiAgent` is on (removed solo-dev cost-discipline bypass)

---

## [1.0.57] - 2026-06-15

**Summary:** Close Claude VS Code attribution gap (PreToolUse workaround + dashboard warning) and auto-expand task focus when active skills go unused.

**Theme:** Attribution reliability & task skill focus

### Behavior changes

- **Claude VS Code gap detection** — scans `~/.claude/projects` transcripts for `claude-vscode` sessions with tool use but zero `PostToolUse` hook fires; dashboard hook panel shows warning and CLI/PreToolUse guidance
- **PreToolUse attribution workaround** — `installAttributionHooks` now registers `skill-invoke-watch.js` on both `PostToolUse` and `PreToolUse` in `.claude/settings.json` (anthropics/claude-code#27014); `skills_sync.py hooks install` parity
- **Task skill underuse promotion** — when task focus is on, a session has meaningful tool activity, and no active skill was invoked, high-confidence ignored skills from `task-skill-proposals.json` are promoted back into the active set (configurable under **Skill feedback**)

---

## [1.0.56] - 2026-06-14

**Summary:** Close cost-control gaps — stop installing budget hooks on attribution-only workspaces; align CLI hook file list and docs.

**Theme:** Cost control hook parity (hardening)

### Behavior changes

- `syncHooksOnSkillChange` refreshes cost-control scripts on all agent paths only when `costControlHooksActive()` (any Claude cost hook registered); attribution-only workspaces refresh attribution scripts only
- `skills_sync.py` `HOOK_FILES` includes `hookPlatform.js` and `task-skill-focus.js`; removed superseded per-hook task-drift installers

---

## [1.0.55] - 2026-06-14

**Summary:** Full four-agent cost-control hook parity — all five prompt hooks (budget, session size, context focus, practical focus, task drift) register and run on Claude, Cursor, Kiro, and Copilot.

**Theme:** Cost control hook parity

### Highlights

- **`hookPlatform.js`** — shared `resolveCwd`, `parsePlatform`, and per-agent `writePromptOutput` for Cursor `additional_context`, Kiro `additional_context`, Copilot `hookSpecificOutput`, and Claude `systemMessage` / `hookSpecificOutput`
- **All five hooks** — `installAgentCostControlPromptHooks()` registers session-size, budget, context-focus, practical-focus, and task-drift on Cursor `beforeSubmitPrompt`, Kiro `promptSubmit`, and Copilot `UserPromptSubmit`
- **Budget-watch fix** — resolves `workspace_roots` (not only `cwd`) and emits the correct output shape per agent; hook commands pass `cursor` / `kiro` / `copilot` argv
- **CLI parity** — `skills_sync.py hooks install --full` installs the same five hooks for all enabled agents
- **Hook status** — `getWorkspaceHookStatus()` checks Claude + agent mirror for each cost-control hook

### Behavior changes

- Re-run **Enable Cost Control Hooks** to add session-size / focus hooks on Cursor/Kiro/Copilot and refresh budget commands with platform args
- Session-size warnings still require `transcript_path` (Claude + Cursor); Kiro/Copilot hooks register but no-op without transcripts

---

## [1.0.54] - 2026-06-14

**Summary:** Fix Kiro `.kiro.hook` schema — use `promptSubmit` and `sessionStart` for `when.type` (Kiro rejects `userPromptSubmit` / `agentSpawn`).

**Theme:** Four-agent hook parity (Kiro schema compliance)

### Behavior changes

- Kiro budget and task-drift hooks now register `when.type: promptSubmit` instead of `userPromptSubmit`
- Kiro profile-init hook now registers `when.type: sessionStart` instead of `agentSpawn`
- Re-run **Enable Cost Control Hooks** or **Install Profile Init Session Hook** (or reload the workspace) to rewrite existing `.kiro/hooks/*.kiro.hook` files
- `profile-init-watch.js` still accepts legacy `agentSpawn` stdin events for backward compatibility

---

## [1.0.53] - 2026-06-14

**Summary:** Cost discipline pack — cap task skills at 8–12, bootstrap new branches with relevant subsets, budget tier gating, and weekly resolver for economy tiers.

**Theme:** Task focus & branch-local skill economy

### Highlights

- **Task skill focus cap** — `claudeSkills.taskFocus.maxActiveSkills` (default 12) limits active + proposed skills; required platform skills count toward the cap
- **Branch bootstrap** — new branches without a saved profile get infra/app heuristics + relevant-only install instead of inheriting main's full library
- **Budget tier gating** — high-tier skills outside the active task set auto-disable at 80% daily budget; medium-tier at 95%
- **Relevant install only** — prunes personal-local irrelevant skills when installs exceed 2× the focus cap
- **Weekly resolver** — `skillSetResolver` tier feature enabled for `solo-dev` and `budget-sensitive`; unset `skillSetResolver.enabled` follows tier default
- **Four-agent parity** — cost discipline propagates to Cursor/Kiro/Copilot mirrors + Copilot bootstrap; budget-watch hooks on all four agents; learning artifacts mirrored to `.cursor/learning` / `.kiro/learning`
- **Host-first entry** — extension detects running IDE (`detectHostAgentId`); imports host mirror skills/learning into canonical `.claude/` when you never opened Claude Code first; per-IDE skill sets work on solo-dev tier in Cursor/Kiro/VS Code

### Behavior changes

- Switching to a new branch seeds a focused skill profile when branch bootstrap is on (profile init prompt still runs when enabled)
- Task proposals and focus ignore skills beyond the configured cap (extension + `task-skill-focus.js` hook)
- Cost discipline pass always runs host-first bootstrap, then fans out to non-Claude agents when `propagateToAllAgents` is on (default)
- Opening the extension in Cursor/Kiro/Copilot bootstraps `.claude/skills` and `.claude/learning` from the host mirror when canonical copies are missing
- `cli-config.json` includes `taskFocus` and `costDiscipline` blocks for headless hook parity

---

## [1.0.52] - 2026-06-14

**Summary:** Releases 1.0.45–1.0.51 are now parity-checked across Claude, Cursor, Kiro, and Copilot — task drift inject, session-start fallbacks, and transcript-based session-size drift for Cursor/Claude.

**Theme:** Four-agent hook parity for cost intelligence & skill adaptation

### Highlights

- **Task drift (1.0.51)** — `task-drift-watch.js` registered for all four agents: Claude `UserPromptSubmit`, Cursor `beforeSubmitPrompt`, Kiro `userPromptSubmit`, Copilot `UserPromptSubmit` / `userPromptSubmitted`
- **Session-start fallback** — `profile-init-watch.js` delivers pending task-drift prompts on Claude SessionStart, Cursor sessionStart, Kiro agentSpawn, and Copilot SessionStart (same path as 1.0.50 low-trust inject)
- **Session-size drift** — extension also reads Claude/Cursor transcript file sizes when evaluating task drift (Kiro/Copilot lack local transcripts per `agents.json`)
- **Attribution & costs (1.0.46–1.0.49)** — unchanged multi-agent PostToolUse hooks; General API panel remains Claude/Cursor transcript–based where transcripts exist
- **Per-skill cross-agent costs** — `buildCostAttribution` now uses measured hook `cost` from `runs.jsonl` (API usage breakdown) instead of re-estimating with a flat blended $/M rate — aligns Cross-agent panel with Usage Report **$X/run (API)** rows
- **Agent routing hint** — when daily budget is nearly exhausted, routing suggestion explains budget-driven Copilot fallback vs measured cheapest agent
- **claude-api lint** — trimmed SKILL/instructions frontmatter description to ≤500 chars (trigger/skip rules remain in body)

### Behavior changes

- Cross-agent **Per-skill** table and routing cost parentheses now match hook-measured costs (~$0.05/run with heavy cache read) instead of inflated blended estimates (~$0.30/run)
- **Suggested agent: copilot** during budget exhaustion now includes explicit “daily budget nearly exhausted” context

### Technical

- `hookOps.ts` — `installAgentTaskDriftHooks()` for Cursor/Kiro/Copilot; separate `.github/hooks/claude-skills-task-drift.json` and `.kiro/hooks/claude-skills-task-drift.kiro.hook`
- `taskDriftReproposal.ts` — merges `session-watch.json` with workspace Claude/Cursor transcript byte thresholds
- `skills_sync.py` — headless task-drift hook install when `hooks install --full`
- `costAttribution.ts` — `costForRunRecord()` prefers stored `rec.cost`; `formatAttributionReport` labels column **Cost** with hook vs estimate note
- `costRouter.ts` — `formatRoutingSuggestion()` budget context when cheapest agent differs from routed agent
- `.claude/skills/claude-api/SKILL.md`, `.github/instructions/claude-api.instructions.md` — short frontmatter description

---

## [1.0.51] - 2026-06-14

**Summary:** Task scope drift (off-profile skill use or large session) now auto-refreshes `task-skill-proposals.json`, re-applies task focus, and injects a one-time agent hint.

**Theme:** Reactive skill re-proposal when agents drift from the active task set

### Highlights

- **Feature** — `claudeSkills.features.taskDriftReproposal` (default on)
- **Triggers** — `not_in_active_profile` invokes in `runs.jsonl` (default ≥2) and/or session transcript at warn/critical (`session-watch.json`)
- **Settings** — `claudeSkills.skillFeedback.taskDriftMinOffProfileInvokes`, `taskDriftSessionSizeLevel`, `taskDriftCooldownMinutes`, `taskDriftNotifyUser`
- **Hook** — `task-drift-watch.js`: Claude Code `UserPromptSubmit` + Cursor `beforeSubmitPrompt` inject refreshed active skill list once per drift event (Kiro/Copilot added in **1.0.52**)
- **State files** — `.claude/learning/task-drift-reproposal.json`, `task-drift-prompt.json`

### Behavior changes

- Extension refresh cycle evaluates drift before normal deterministic proposal refresh; cooldown prevents rapid re-proposal loops (default 30 min)
- Off-profile skills used by the agent are boosted into the refreshed proposal set with high confidence
- `applyTaskProposalsIfPending` still auto-installs/enables when `autoApplyTaskProposals` is on

### Technical

- `taskDriftReproposal.ts` — detection, heuristic refresh, focus re-apply, prompt snapshot
- Cost-control hook install now registers `task-drift-watch.js` alongside session-size and context-focus hooks

### Known gaps (addressed in 1.0.52)

- ~~**Kiro / Copilot** — mid-session agent inject~~ → wired in 1.0.52
- **Heuristic refresh** — extension re-seeds proposals from workspace heuristics; agent refinement via `skill-feedback-adaptation` section 3 is still optional after drift inject
- **General API spend (1.0.49)** — Kiro/Copilot have no local transcript roots; panel uses Claude/Cursor session data only

---

## [1.0.50] - 2026-06-14

**Summary:** Low cost-attribution trust now triggers a silent SessionStart hint to agents (configurable threshold, default 50%).

**Theme:** Agent awareness when cost data is unreliable

### Highlights

- **Settings** — `claudeSkills.costIntelligence.lowTrustPromptEnabled` and `lowTrustPromptThresholdPct` (0–100)
- **SessionStart hook** — when trust score is below threshold, agents receive grounding not to rely on per-skill cost rankings
- **Snapshot file** — `.claude/learning/attribution-trust.json` updated on dashboard refresh

### Technical

- `attributionTrustConfig.ts` syncs trust score from `assessAttributionHealth` + `buildGlobalTrustBadge`
- `profile-init-watch.js` appends low-trust context on Claude, Cursor, Kiro, and Copilot session start

---

## [1.0.49] - 2026-06-14

**Summary:** Cost dashboard now shows **General API** spend — base-model session work and residuals not attributed to listed skill invokes.

**Theme:** Non-skill agent usage visibility

### Highlights

- **General API · 14d** panel — transcript session totals minus hook-measured skill invokes; covers agents answering from built-in knowledge without reading a listed skill
- **Overview stat** — **General API** pill alongside **Skill spend** and session totals
- **Collector fix** — routes non-skill sessions to `base_context` instead of inflating legacy `unattributed`
- **Hook metadata** — `not_in_active_profile: true` when a skill file is read outside the active task/profile set

### Technical

- `generalApiSpend.ts` — `computeGeneralApiSpend()`, session residual helpers
- `applyTranscriptAttribution()` — hook sessions: `session_tokens − hook_tokens`; no-skill sessions: full session → `base_context`
- Legacy `unattributed` bucket flagged for reset when pre-1.0.49 data dominates

---

## [1.0.48] - 2026-06-14

**Summary:** Cost dashboard **Models by agent** now shows API-priced **Skill invokes** rows from attribution hooks for Cursor (and other agents) — not only the transcript size estimate.

**Theme:** Hook-measured models in per-agent breakdown

### Highlights

- **Models by agent** — prepends **Skill invokes (cursor)** (and per-model ids when logged) from `runs.jsonl` before **cursor-agent (size est.)** transcript proxy
- **Panel note** — explains transcript size estimate vs hook API rows
- **Agent credit usage** — same hook merge for status-bar / overview model breakdown

### Technical

- `aggregateHookModelUsageByAgent()` and `mergeHookModelsIntoAgentRows()` in `usageCost.ts`
- `computePerAgentCreditUsage()` merges hook models when workspace target is set
- Unit test for Cursor hook model aggregation

---

## [1.0.47] - 2026-06-14

**Summary:** Skills tree, status bar, and usage report show API-priced costs from real hook usage when available — not blanket "Est." labels.

**Theme:** Measured cost labels everywhere hooks fire

### Highlights

- **Skills library tree** — `$X/session (API)` from measured `runs.jsonl` cost; `(catalog)` only when no runs logged
- **Status bar** — `API` / `Mixed` / `Est.` prefix based on whether today's transcripts include usage metadata
- **Usage report** — **Cost/run** column with API vs logged basis per skill
- **Dashboard overview** — **Session spend** when transcripts have full API usage lines

### Technical

- Per-skill stats aggregate `totalCost`, `avgCostUsd`, and `measuredRuns` from hook rows
- ROI/confidence upgrades when `usage_breakdown` metadata is present
- Dashboard top-skill rows show **API-priced (hooks)** trust label when usage breakdown is present

---

## [1.0.46] - 2026-06-14

**Summary:** Cost dashboard and CLI now show real per-skill spend from hook invocations at published API rates — not inflated transcript equal-split estimates.

**Theme:** Accurate skill-level cost attribution

### Highlights

- **Top skills · measured** — dashboard ranks skills from `runs.jsonl` hook/self-learning rows with input/output/cache pricing per model
- **Skill spend** overview stat — separate hook-grounded total in the 14-day Overview panel
- **Model-aware pricing** — Fable/Mythos/Opus/Sonnet/Haiku tiers; API vs size-estimate labels on agent model rows
- **Python CLIs** — `scripts/skill_cost_from_runs.py` (per-skill from logs) and `scripts/agent_billing_report.py` (Anthropic/Cursor/Copilot admin APIs)

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

- **Weekly benefits report** — email opens with tier savings, skill success rates, hook-tracked invocations, and cross-agent savings from `runs.jsonl` + `project-profile.json`
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

**Summary:** Stays out of your way — quieter notifications, no terminal hijack, tier lock that sticks, and silent self-updates from Open VSX.

**Theme:** Quiet operations & reliable tier control

### Highlights

- **Minimal notifications** by default — background auto-apply and suggestions log to Output instead of toasting
- **Output panel stays hidden** unless you ask (`revealOutputPanel` off by default; new **Show Output Log** command)
- **Silent extension auto-update** checks Open VSX every 6 hours and installs newer releases without prompts
- **Manual tier lock** prefers your on-disk plan over stale workspace settings; **solo-focused** plan overrides team detection on shared repos

### Behavior changes

- Locked tiers no longer spam “tier changed” when you already chose a plan
- First-run welcome and setup wizards skipped unless `notificationLevel` is **normal**
- `silent` notification level auto-accepts detected tier (no QuickPick on first open)
- Tier benefit benchmark (`npm run bench:tier-benefits`) and cross-platform skill-impact bench on Windows

### Configuration

- `claudeSkills.notificationLevel` — `minimal` (default), `silent`, or `normal`
- `claudeSkills.revealOutputPanel` (default off)
- `claudeSkills.autoUpdateExtension` (default on)
- `claudeSkills.autoUpdateExtensionHours` (default 6)

### Technical

- `userNotify` module centralizes toast gating; CI vscode mock fixes for `Uri`/`inspect`
- `extensionAutoUpdate` pulls latest VSIX from Open VSX with gallery fallback

---

## [1.0.43] - 2026-06-14

**Summary:** More accurate team-tier detection for fresh clones — uses remote Git signals, not just your local checkout.

**Theme:** Remote-aware tier intelligence

### Highlights

- Choosing a tier now probes `origin` with plain `git` commands (extension-only — no AI agent involved)
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

**Summary:** Compare tier plans with estimated savings before you commit — and manual tier changes finally stick.

**Theme:** Project tiering & cost optimization

### Highlights

- Every plan in the tier picker shows estimated monthly overhead and savings vs full stack
- Comparison table logged before you pick (all 5 tiers side-by-side)
- Switch tiers any time to explore what solo vs multi-agent actually costs

### Behavior changes

- Explicit plan choices (including throwaway and enterprise) **lock** the tier — auto-detect no longer overwrites your pick
- Saved `manualOverride` is respected even when `lockedTier` is empty in settings

### UX

- **Show Project Tier** and **Choose Project Profile Tier** display economics per option
- **View details** action after confirming a plan

---

## [1.0.41] - 2026-06-14

**Summary:** Tier detection driven by real repo activity (git history, branches, files) — and the first-open dialog asks about your *plans*, not a tier catalog.

**Theme:** Project tiering & cost optimization

### Highlights

- Git-first detection: commits, authors, branches, repo size, and age — not just “which AI folders exist”
- **AIDLC greenfield** plan: solo developers on AI-DLC can get multi-agent tier from day one
- Plans prompt: AIDLC, multi-agent workflow, team product, budget, quick spike, or accept detected

### Behavior changes

- New git repos default to **solo-dev** (not throwaway) unless multi-agent or AIDLC signals are present
- First-open plans dialog no longer skipped on new workspaces (prompt state fix)

### UX

- Status bar tooltip, cost dashboard, and output channel show git analysis evidence

---

## [1.0.40] - 2026-06-14

**Summary:** New projects get asked how you plan to use AI agents — instead of silently landing on solo-dev.

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

**Summary:** Your project tier is visible everywhere — status bar, dashboard, and notifications — with estimated savings.

**Theme:** Project tiering & cost optimization

### Highlights

- Status bar badge: `TEAM MULTI-AGENT`, `SOLO DEV`, `BUDGET-SENSITIVE`, etc.
- Cost dashboard **Project tier** panel: detected type, overhead, savings, feature list
- Toast when tier changes with **View details** / **Change tier** actions

### UX

- Command: **Show Project Tier** — full breakdown in output channel

---

## [1.0.38] - 2026-06-14

**Summary:** The extension auto-configures CPU and token spend per project — solo, team, budget, enterprise, or throwaway.

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

- `npm run bench:complete` — hot paths, cost pipeline, hooks, adaptation, CI/ADX harness with SLA checks
- `npm run bench:skill-impact` — Claude CLI A/B with vs without skills; cost and token diffs

### Tooling

- Complex agent fixture (`agent-comparison-fixture-complex/`) with ADX KQL grader
- `resolve-library-dir.mjs`, `installed-extension-path.mjs` for reliable local benchmarks
- Install smoke no longer hardcodes extension version

### Docs

- `COMPLETE-BENCHMARK-GUIDE.md` — `bench:complete` vs `bench:skill-impact`

---

## [1.0.36] - 2026-06-14

**Summary:** Git commands hardened against shell injection — safer on untrusted workspace paths.

**Theme:** Security hardening

### Security

- `branchProfiles.ts` and `skillOps.ts` use `execFileSync("git", [...])` with argument arrays instead of shell string interpolation

---

## [1.0.35] - 2026-06-14

**Summary:** Cost dashboard loads from cache in milliseconds — team economics precomputed in the background.

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

**Summary:** Cost dashboard went from ~7 seconds to ~200 ms — a **97%** improvement for daily use.

**Theme:** Dashboard & cache performance

### Performance

- **Dashboard load time:** ~7 s → ~**200 ms** (~**97%** faster)
- Git blame author lookups cached by `SKILL.md` mtime
- Single `attributeCostToAuthors` pass per render (was double)
- Skill detection: faster glob filtering + expanded exclude dirs (`.vscode-test`, `dist`, `out`, `build`, …)

### Efficiency

- No duplicate cost pipeline run when opening dashboard
- Runs index rebuild skipped when indexes are already fresh
- Tree view skips `computeUsageStats` when cost-aware search is off

---

## [1.0.33] - 2026-06-14

**Summary:** Sync engine overhaul — no more UI jank when toggling skills or mirroring to Cursor/Kiro/Copilot.

**Theme:** Sync engine stability & concurrency

### Highlights

- Chunked async fan-out: agent sync yields between each agent (eliminates burst jank)
- Predictive pre-sync fingerprint: rapid on-off toggles before debounce flushes are skipped silently
- Activity-aware interaction lock: sync pauses while you type, click, or run commands

### Performance targets

- `toggle-ui` **< 16 ms** · `tree-refresh` **< 10 ms** · sync **< 150 ms** (p50/p95/p99 logged)

### UX

- Toggle ripple: 130 ms green check flash on checkbox
- Lock-free runs reads; size-stable hash reuse across Windows git-checkout mtime drift

### Planned (v1.1)

- Worker thread for cost pipeline + JSONL aggregation

---

## [1.0.32] - 2026-06-14

**Summary:** Smoother skill toggles — background sync waits until you stop interacting.

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

**Summary:** Smarter debouncing — fast response when you act, quiet coalescing in the background.

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

**Summary:** Foundation of the modern sync architecture — hash-based copies, coalesced queues, lazy startup.

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

**Summary:** See which AI agent (Claude, Cursor, Kiro, Copilot) used which skills — and trim token load automatically.

**Theme:** Multi-agent visibility & automation

### Highlights

- Cross-agent usage matrix in Usage Report and weekly email
- Task skill focus: non-proposed skills set `off` after auto-apply to save tokens
- Deterministic profile init and task proposals without an agent session

### Performance

- Manifest/skill-status/detection caches; coalesced workspace refresh

---

## [1.0.28] - 2026-06-13

**Summary:** Integration smoke test in CI — extension activation verified before every publish.

**Theme:** Release quality & session hooks

### Highlights

- `@vscode/test-electron` integration smoke (`npm run test:integration`)
- NEW SESSION task-proposal hook on all four agent platforms
- Weekly batch release policy documented in `PUBLISHING.md`

---

## [1.0.27] - 2026-06-13

**Summary:** Proposed skills auto-install when `task-skill-proposals.json` updates — no manual apply step.

**Theme:** Session automation

### Behavior changes

- `autoApplyTaskProposals` (default on): installs and enables every skill in **Proposed for current task**
- Session skill apply no longer caps at 20 skills when merging profile + proposals

---

## [1.0.26] - 2026-06-13

**Summary:** Full headless Claude CLI workflow — apply skills, sync branch profiles, install hooks without VS Code open.

**Theme:** Headless CLI & hooks

### Highlights

- `skills_sync.py` + `generate_skills.py`: `apply-session`, `apply-profile`, `sync-branch`, `sync-agents`, `hooks install`
- **Prepare for Claude CLI** command — one-click setup
- `.claude/learning/cli-config.json` mirrors IDE feature toggles for CLI/hooks

---

## [1.0.25] - 2026-06-13

**Summary:** Skills follow you into every new agent session — Cursor, Kiro, Copilot, and Claude Code.

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

**Summary:** Different skill sets per IDE and per git branch — Cursor, Kiro, Copilot, Claude Code.

**Theme:** Per-IDE skill profiles

### Highlights

- Save and switch skill sets per branch per IDE (`~/.claude/learning/agent-skill-profiles.json`)
- Auto-apply on workspace open when a saved set exists

---

## [1.0.21] - 2026-06-13

**Summary:** Extension available on Open VSX — install in Cursor and Kiro IDE, not only VS Marketplace.

**Theme:** Distribution

### Highlights

- `npm run publish:openvsx` + GitHub Actions **Publish Extension** workflow
- `cursor-kiro-extension-publishing` skill for agent-guided publish

---

## [1.0.20] - 2026-06-13

**Summary:** Skills learn from your feedback — and the extension suggests better skills when spend spikes.

**Theme:** Skill feedback & lifecycle

### Highlights

- `skill-feedback-adaptation` skill: disagreement logging + task proposals
- High token usage popup when branch/task exceeds **50%** of monthly credits (configurable)
- Skill versioning in manifest: outdated alerts + **Upgrade Outdated Skills**
- Attribution trust badge: Reliable / Estimated / Low confidence

---

## [1.0.19] - 2026-06-12

**Summary:** Confidence scores everywhere — and the optimizer reacts in real time after each cost sync.

**Theme:** Cost intelligence depth

### Highlights

- Trust banner and per-skill confidence (`high` / `estimated` / `low`) on Usage Report
- `autoDetectOnPipeline` (default on): debounced auto-optimize ~5 seconds after pipeline sync
- In-memory runs + transcript indexes avoid full re-parses

---

## [1.0.18] - 2026-06-12

**Summary:** Attribution you can trust — Cursor hooks fixed, pipeline resilient, dashboard faster to read.

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

**Summary:** ROI and trust layers on cost data — see dollars saved, not just dollars spent.

**Theme:** FinOps foundation

### Highlights

- Per-skill ROI bands (`HIGH` / `MEDIUM` / `LOW`) with time-saved heuristics
- Value panel: minutes saved, dollar value, net ROI in Cost Intelligence Dashboard
- Unified system state: `.claude/learning/system-state.json`

---

## [1.0.1] - 2026-06-12

Same content as consolidated **1.0.0** below — first publishable Marketplace version after 1.0.0 was already taken.

---

## [1.0.0] - 2026-06-12

**Summary:** First production release — bundled skills, four-agent sync, profile init, and cost intelligence.

**Theme:** Foundation

### Highlights

- Bundled skill library with stack detection (`manifest.json` + `detect_globs`)
- Multi-agent deploy: Claude Code, Cursor, Kiro, GitHub Copilot
- Profile init on new branches (agent-driven skill selection by role)
- Cost Intelligence Dashboard, budget modes, attribution collector
- Activity bar Skills tree, setup wizard, onboarding tour

### Requirements

- VS Code / Cursor **1.85+**; optional `vscode.git` and GitHub CLI
