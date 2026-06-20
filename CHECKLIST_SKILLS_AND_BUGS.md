# Skills Library + Bug Backlog — Post v1.0.81

Generated: 2026-06-21  
Context: v1.0.81 simplification + BOM/mojibake fixes applied. Reviewing skill gaps
and remaining bugs from the CHANGELOG and this refactor session.

---

## Part A — Remaining Bugs

### A.1 Path case-sensitivity in MCP filesystem server (HIGH)

**Problem:** On Windows, `path.resolve()` returns `C:\Users\...` (uppercase drive)
but allowed-dirs may be stored as `c:\Users\...` (lowercase). Any `startsWith`
comparison fails silently, producing the error:
> `"C:\...\runsIndex.ts" is outside allowed directories. Allowed: c:\...`

**File:** The allowed-dirs check logic in `resources/mcp-lazy-proxy.js` or the
filesystem server binary — wherever `allowedDirs` is compared against the target path.

**Fix:**
```js
const allowed = path.resolve(dir).toLowerCase();
const target  = path.resolve(targetPath).toLowerCase();
return target.startsWith(allowed);
```
Use `.toLowerCase()` on both sides before any `startsWith` / `includes` comparison.

**Also check:** `hookOps.ts` and any other code that calls `path.resolve` for
allowed-dir comparisons.

- [ ] Locate the `startsWith(allowedDir)` call in the MCP filesystem server
- [ ] Replace with case-insensitive comparison (both sides `.toLowerCase()`)
- [ ] Add a test: allowed dir `c:\foo`, target path `C:\foo\file.ts` → allowed

---

### A.2 Dead config key `approveSkillSets` (LOW)

**Problem:** `taskFocusConfig.ts` still reads and returns `approveSkillSets` from
`claudeSkills.taskFocus.approveSkillSets` VS Code config. The feature it gated
(task skill set approval dialog) was removed in Phase 8. The key is now dead.

- [ ] Remove `approveSkillSets` from `readTaskFocusLimits()` return type and body
- [ ] Remove the `claudeSkills.taskFocus.approveSkillSets` entry from `package.json`

---

### A.3 Dead code: `isFullMultiAgentMirrorMode` host-only path (LOW)

**Problem:** `agentOps.ts` line 91: `isFullMultiAgentMirrorMode()` is hardcoded to
`return true`. Lines 116–120 of `workspaceMirrorAgentIds` (the host-only fallback
path via `detectHostAgentId()`) are now permanently unreachable dead code.

- [ ] Remove the `if (isFullMultiAgentMirrorMode())` branch guard; inline the full-fan-out logic directly
- [ ] Delete `isFullMultiAgentMirrorMode()` function
- [ ] Update `workspaceMirrorAgentIds` JSDoc (remove "solo-dev host IDE only" note)

---

### A.4 Phase 9.2 cleanup items not yet done (MEDIUM)

From CHECKLIST_1.0.81.md Phase 9.2 — these three items were listed but skipped:

- [ ] **`agentMirrorSync.ts`** — audit callers. If only `hostAgentBootstrap.ts` calls it, inline and delete.
- [ ] **`collectorState.ts`** — inline its two functions into `attributionCollector.ts` and delete.
- [ ] **`extensionSharedContext.ts`** — audit global mutable state; replace with dependency injection where safe.

---

### A.5 `mcp-lazy-proxy.js` still writes to global MCP log (LOW)

From Phase 7 checklist:
> Check `resources/mcp-lazy-proxy.js` — if it writes to the global log, update to workspace path.

This was noted as a task but not confirmed done.

- [ ] Open `resources/mcp-lazy-proxy.js`; grep for `mcp-usage.jsonl` and `homedir()`
- [ ] If global write exists, change to workspace-scoped path (`<cwd>/.claude/mcp-usage.jsonl`)

---

### A.6 PS5.1 BOM re-introduced risk (process, not code) (LOW)

Any future PowerShell batch edit using `Get-Content $f -Raw` + `Set-Content -Encoding utf8`
will re-introduce BOM and mojibake. We fixed 26 files this session but the root cause
is tooling behavior, not code.

- [ ] Add pre-commit hook or CI check: `find extension/src -name "*.ts" | xargs grep -lP "^\xEF\xBB\xBF"` (fail if BOM found)
- [ ] Add `cross-platform-scripting` skill invocation to any future PowerShell scripting tasks (already updated)

---

## Part B — Skills to Update

### B.1 `cross-platform-scripting` ✅ DONE (this session)

Added Section 5 covering:
- PS5.1 `Set-Content utf8` adds BOM
- `.NET WriteAllText` with `UTF8Encoding($False)` as the fix
- BOM detection and stripping recipe

---

### B.2 `skill-creator` — add hook architecture section

The hook system changed significantly in v1.0.81: three hooks merged into
`prompt-context-watch.js`, hook server handles `prompt-context` case. Any
skill that documents creating hooks for this extension is now partially stale.

**Check:** Does the skill reference `session-size-watch.js`, `context-focus-watch.js`,
or `practical-focus-watch.js` by name?

- [ ] Read `skills_library/skill-creator/SKILL.md`
- [ ] Remove/update any references to the 3 merged hooks
- [ ] Add note: prompt-context-watch.js handles UserPromptSubmit context injection

---

### B.3 `self-learning` — verify module import paths still valid

The `self-learning` skill records outcomes to `runs.jsonl` via `appendSkillRun`.
After the refactor, `appendSkillRun` moved from `runRecording.ts` → `runsStore.ts`.

**Check:** Does the skill tell the agent to import from a specific module path?

- [ ] Read `skills_library/self-learning/SKILL.md`
- [ ] If it references `runRecording`, update to `runsStore`
- [ ] If it references `learningStateIndex`, update to `runsStore`

---

### B.4 `skill-feedback-adaptation` — same module-path check

- [ ] Read `skills_library/skill-feedback-adaptation/SKILL.md`
- [ ] Update any `runRecording` / `learningStateIndex` references to `runsStore`

---

### B.5 `skill-usage-insights` — same module-path check

- [ ] Read `skills_library/skill-usage-insights/SKILL.md`
- [ ] Update any stale module references
- [ ] Verify the KPI file paths (`.claude/learning/skill-stats.json`,
  `daily-stats.json`) are still correct — they are (unchanged in runsStore)

---

### B.6 `profile-init` — verify hook reference still valid

The skill triggers on `profile-init-watch.js` SessionStart. That file is still
present and the hook registration is unchanged. But check if the skill references
any removed features (task-skill-set approval, `approvalStatus`).

- [ ] Read `skills_library/profile-init/SKILL.md`
- [ ] Remove any references to `approvalStatus` / "pending approval" flow

---

### B.7 `terraform-module-ops` and `terraform-plan-review`

These two skills were removed from `.github/instructions/` in v1.0.81 but the
actual skill directories still exist in `skills_library/`. Their `.github`
instruction files were deleted (D in git), but the skill SKILL.md files remain.

- [ ] Decide: keep skills in library (users can still install) — no change needed
- [ ] OR: if the decision was to deprecate them entirely, add `deprecated: true` to
  their SKILL.md frontmatter

---

## Part C — New Skills to Add

### C.1 `mcp-efficiency-guide` (NEW — HIGH VALUE)

**Why:** Since v1.0.63 the extension has a full MCP efficiency engine — it tracks
waste (repeated reads, read-after-write, agent loops, large files, excessive scans)
and generates actionable hints. A skill that teaches agents how to read and act on
this data would close the loop.

**What to cover:**
- How to read `~/.claude/learning/mcp-agent-hints.md` (auto-generated)
- Common waste patterns and fixes (cache reads, batch directory listings, etc.)
- How to trigger a manual efficiency review: `Claude Skills: Efficiency Report`
- `lazy-mcp` and `mcp-compressor` for structural token reduction

- [ ] Create `skills_library/mcp-efficiency-guide/SKILL.md`

---

### C.2 `prompt-context-hooks` (NEW — MEDIUM)

**Why:** The `prompt-context-watch.js` hook is now the single injection point for
context grounding + practical focus. Agents working on this extension or setting
up workspaces need to understand what the hook injects and how to configure it.

**What to cover:**
- How `context-focus.json` controls grounding level (knowledge / balanced / local-first / strict-local)
- How `practical-focus.json` controls deployment guidance (off by default)
- Session size escalation: when the transcript grows, grounding automatically tightens
- How to disable injection for a session: `injectEveryPrompt: false`

- [ ] Create `skills_library/prompt-context-hooks/SKILL.md`

---

### C.3 `cost-attribution-setup` (NEW — MEDIUM)

**Why:** The attribution v2 hooks + confidence scoring + system mode are complex
and poorly covered by existing skills. Agents frequently ask "why is my attribution
low?" or "how do I enable measured costs?".

**What to cover:**
- Attribution v2: PostToolUse hooks → `runs.jsonl` with `source: skill-invoke-hook-v2`
- Confidence levels (high / estimated / low) and how to improve them
- System mode: safe / degraded / normal gates for optimizer
- "Reset Mis-attributed Cost Data" command and when to use it
- How to check: `Claude Skills: Open Cost Dashboard` → trust banner

- [ ] Create `skills_library/cost-attribution-setup/SKILL.md`

---

### C.4 `windows-dev-environment` (NEW — MEDIUM, based on this session)

**Why:** This session uncovered multiple Windows-specific issues:
- PS5.1 BOM encoding (`Set-Content utf8` with BOM)
- Path case-sensitivity (`C:\` vs `c:\`)
- CRLF vs LF line endings causing Node.js shebang failures
- CP1252 vs UTF-8 terminal encoding causing mojibake in output

These are not covered by `cross-platform-scripting` at the level of practical
workarounds for Windows dev environments.

**What to cover:**
- Always use `.NET WriteAllText` for file writes in PS5.1 (not `Set-Content`)
- Normalize paths before comparison: `path.resolve(p).toLowerCase()`
- Node.js on Windows: UTF-8 BOM in JS files breaks shebangs → use `WriteAllBytes` to strip
- VS Code extension output: UTF-8 characters display correctly; source file encoding is key
- Line endings: `git config core.autocrlf false` for repos with `.sh` scripts
- Test for BOM: first byte `0xEF 0xBB 0xBF` = BOM

- [ ] Create `skills_library/windows-dev-environment/SKILL.md`

---

## Execution Order (recommended)

```
A.1 (MCP path case) → A.2 (dead config) → C.1 (mcp-efficiency) →
B.2-B.6 (skill updates) → A.3-A.5 (remaining dead code) →
C.2-C.4 (new skills) → A.6 (CI BOM check)
```

**Quick wins (< 30 min each):** A.2, A.3, B.3, B.4, B.5, B.6
**Medium effort (1-2 h each):** A.1, A.4, C.1, C.2, C.3, C.4
**Lowest priority:** A.5, A.6, B.7

---

_Total: 6 bug fixes (2 high, 2 medium, 2 low) + 6 skill updates + 4 new skills_
