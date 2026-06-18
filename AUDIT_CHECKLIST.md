# Audit Checklist — claude-skill-deployer v1.0.75

Generated from full end-to-end audit (2026-06-18).
Track each item: **[ ]** open → **[x]** fixed → **[~]** accepted-risk / won't-fix.

---

## HIGH severity

- [x] **H1** Symlink traversal not blocked in filesystem MCP server
  - File: `extension/resources/mcp-servers/filesystem/index.js`
  - Fix: add `fs.realpathSync()` call inside `assertAllowed()` and re-check resolved real path against allowed dirs
  - Test: add symlink escape test in `tests/mcp-security.test.js`

- [x] **H2** SMTP EHLO state machine hangs against most production mail servers
  - File: `extension/src/weeklyReport.ts` — `smtpSession()`
  - Fix: replace `line.includes("localhost")` with `line[3] === " "` (RFC 5321 terminal-line check) for steps 1 and 3

- [x] **H3** SMTP password exposable via VS Code workspace settings
  - File: `extension/package.json` — remove `claudeSkills.weeklyReport.smtpPassword` from `contributes.configuration`
  - File: `extension/src/weeklyReport.ts` — `readWeeklyReportConfig()`: remove `cfg.get("smtpPassword")` fallback; keep only env-var fallback; SecretStorage path in `loadWeeklyReportSecrets()` is correct

---

## MEDIUM severity

- [x] **M1** `summarizeMcpUsage(logPath)` test passes vacuously — wrong argument order
  - File: `extension/src/mcpUsageLog.test.ts` line 431
  - Fix: change `summarizeMcpUsage(logPath)` → `summarizeMcpUsage(14, logPath)`

- [x] **M2** ReDoS via user-supplied regex in `search_in_file` (filesystem MCP)
  - File: `extension/resources/mcp-servers/filesystem/index.js`
  - Fix: cap pattern length at 500 chars; add 5-second time budget with check every 200 lines

- [x] **M3** `getAllowedDirs()` synchronous config re-read on every tool call (no caching)
  - File: `extension/resources/mcp-servers/filesystem/index.js`
  - Fix: add `_allowedDirsCache` + `fs.watch()` invalidator (mirrors pattern already in CLI MCP server)

- [x] **M4** `generate_skills.py setup-task` emits Windows-only `py` command
  - File: `generate_skills.py` — `cmd_setup_task()`
  - Fix: use `sys.platform == "win32"` check; emit `py` on Windows, `python3` elsewhere

- [x] **M5** Module-level `lastKnownBranch` singleton breaks multi-root workspaces
  - File: `extension/src/branchProfiles.ts`
  - Fix: replace `let lastKnownBranch` with `Map<string, string>` keyed by `path.normalize(target)`; update `handleBranchChange`, `resetBranchTracking`, `initBranchTracking`

- [x] **M6** SMTP email violates RFC 2822 — missing `Date:` and `Content-Type` headers
  - File: `extension/src/weeklyReport.ts` — `smtpSession()` DATA step
  - Fix: add `Date: <utcString>`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8` headers before body

- [~] **M7** `no-reply@...` (hyphenated) not caught by `isNoreplyEmail()`
  - Accepted risk — intentional per inline test comment; hyphenated noreply addresses are uncommon delivery targets

---

## LOW severity

- [~] **L1** VSIX binaries in working tree
  - Not an issue — `extension/.gitignore` already contains `*.vsix`; files are untracked locally only

- [x] **L2** Binary detection missing WebAssembly, BMP, and SQLite signatures
  - File: `extension/resources/mcp-servers/filesystem/index.js`
  - Fix: add `[0x00,0x61,0x73,0x6d]` (WASM), `[0x42,0x4d]` (BMP), `[0x53,0x51,0x4c,0x69]` (SQLite) to `BINARY_SIGNATURES`

- [x] **L3** Security test suite had no symlink-escape test
  - File: `tests/mcp-security.test.js`
  - Fix: add symlink traversal test section alongside the existing path-traversal tests

---

## Documentation

- [x] **D1** README and test prompt claim "461 passing" — actual count is 531
  - File: `tests/e2e_test_prompt.md` — update expected count
  - Note: README references are informational only; test count changes often

---

## Verification

After all fixes, run:

```bash
# Unit + integration tests
cd extension && npm test

# Security tests
node tests/mcp-security.test.js
```

Expected: all tests pass. The symlink test added under H1/L3 will now also pass.
