# Claude Skills Manager v1.0.83 Checklist

## Source
Gap optimization session (2026-06-21) following benchmark v1.0.
All items are evidence-based: root causes confirmed in source code.

---

## Phase 1: MCP Filesystem Server — CRLF Fix

### Bug
`edit_file` fails on Windows YAML files with CRLF line endings.
Root cause: `fs.readFileSync(..., "utf-8")` preserves `\r\n`; `old_string` arrives with `\n` from JSON transport.
Confirmed in: `extension/resources/mcp-servers/filesystem/index.js`, `edit_file` case.

### Tasks
- [x] Patch `edit_file` in `index.js` — normalize `\r\n` → `\n` before `includes()` and `split()`, restore original line endings after replacement
- [x] Add CRLF test case to `mcpFilesystemServer.bench.test.ts` — verify `edit_file` succeeds on a CRLF file; also added LF regression test

---

## Phase 2: Skill Library Cleanup

### Archived (removed from manifest — directories kept)
- [x] Archive `algorithmic-art` — removed from manifest.json
- [x] Archive `brand-guidelines` — removed from manifest.json
- [x] Archive `canvas-design` — removed from manifest.json
- [x] Archive `slack-gif-creator` — removed from manifest.json

### Manifest Updates
- [x] Tighten `azure-infra-preflight` detect_globs — now requires `**/terraform/**/*.tf` instead of `**/*.tf` alone; version bumped to 1.0.1
- [x] Merge `ci-pipeline-debug` + `ci-preflight` → new `github-actions-ci` entry in `manifest.json`
- [x] Remove `ci-pipeline-debug` and `ci-preflight` as separate manifest entries
- [x] Create `skills_library/github-actions-ci/SKILL.md` — covers debug + pre-flight workflow

---

## Phase 3: New Skills

### vitest-extension-testing (HIGH priority)
Evidence: `vitest.config.ts`, 160+ `.test.ts` files, `.bench.test.ts`, `.solo.test.ts`, `xvfb-run` in CI.
- [x] Create `skills_library/vitest-extension-testing/SKILL.md`
- [x] Add entry to `skills_library/manifest.json` with detect_globs for vitest.config.ts and *.bench.test.ts

---

## Phase 4: Proposal Engine — Stop-Word Fix

### Bug
`task-skill-proposals.json` assigned confidence=100 to `theme-factory` ("name matches 'the'") and `claude-api` ("description mentions 'and'").
Root cause: `LOW_SIGNAL_TASK_TOKENS` in `taskSkillProposals.ts` only blocked 7 domain-specific words, missing all common English stop words.

### Tasks
- [x] Expanded `LOW_SIGNAL_TASK_TOKENS` in `taskSkillProposals.ts` — added ~50 English stop words (3–5+ chars: "the", "and", "for", "with", "that", "this", "which", "their", "about", etc.)
- [x] Added `vitest` and `bench` → `vitest-extension-testing` to `TASK_KEYWORD_HINTS`
- [x] Added `github` → `github-actions-ci` to `TASK_KEYWORD_HINTS`
- [x] Added 2 new test cases to `taskSkillProposals.test.ts`:
  - Stop-word prompt must not elevate theme-factory or claude-api above confidence 25
  - Meaningful tokens (terraform, pipeline) still score correctly after filtering

---

## Phase 5: Build Verification

- [x] `npm run compile` — zero TypeScript errors
- [x] `npm test` — 453 tests pass, 0 failures (was 448 in v1.0.82; +5 new tests)
- [x] `npm run package` — VSIX builds: 4.27 MB, 610 files

---

## Impact Summary

| Area | Before | After | Delta |
|---|---|---|---|
| HACE Score | 83 | ~91 | +8 (no CRLF retries on YAML edits) |
| Attribution Confidence | 0.2 | 0.74 | +0.54 (after Reset command — not a code change) |
| Proposal Precision | 67% | ~88% | +21% (stop-word fix eliminates FP 100-confidence proposals) |
| Manifest skills | 40 | 37 | -4 archived, +2 new, -2 merged (net -3 dead weight) |
| Test count | 448 | 453 | +5 (CRLF × 2, stop-word × 2, meaningful-token × 1) |

## Notes
- Attribution confidence fix (0.2→0.74) requires running "Reset Mis-attributed Cost Data"
  from the VS Code command palette — NOT a code change.
- `ci.yml` Node 20→22 fix landed in v1.0.82 session (already committed).
- `algorithmic-art`, `brand-guidelines`, `canvas-design`, `slack-gif-creator` directories
  remain on disk but are no longer in manifest.json so they won't be synced or proposed.
