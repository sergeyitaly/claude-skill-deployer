---
name: mcp-efficiency-guide
description: Read MCP efficiency hints and fix token-waste patterns. Use when asked about MCP efficiency, token waste, redundant tool calls, or "why is my session so token-heavy". Covers mcp-agent-hints.md, common waste patterns, manual efficiency review, and lazy-mcp.
user-invocable: true
allowed-tools:
  - Read
  - Grep
  - Bash
  - mcp__filesystem__read_file
  - mcp__filesystem__write_file
---

# MCP Efficiency Guide

This extension ships an MCP efficiency engine that tracks wasted tokens from
redundant tool calls and surfaces actionable hints via `mcp-agent-hints.md`.
Use this skill when sessions grow wasteful or the user asks about token costs.

## 1. Reading the hints file

**Path:** `~/.claude/learning/mcp-agent-hints.md`

This file is auto-generated (at most once every 30 seconds per target). Read it
at the start of a large session or when the user says "check my efficiency".

Sections in the hints file:
- `## Session efficiency: N% (grade A|B|C|D)` — overall waste score.
- `- Total ops: N  Wasteful: N` — how many redundant calls.
- `- \`<path>\` — read N×, ~N tokens wasted` — cache hot files.
- `- \`<path>\` — listed N×` — excessive directory scans.

Treat the hints file as a briefing. Every line describes a fixable problem.

## 2. Common waste patterns and fixes

| Pattern | Symptom in hints | Fix |
|---|---|---|
| **Redundant reads** | `read N×` on a single file | Cache content in context; do not re-read unless file may have changed. |
| **Read-after-write** | Implied by consecutive read ⇢ write on same file | After writing, assume the content you just produced is authoritative — skip the verification read unless diff is needed. |
| **Agent loop re-read** | Same file read at the start and end of a multi-step task chain | Read once, reason on the cached content, summarize findings rather than re-reading each step. |
| **Agent duplication** | Same tool fired from multiple tool_use blocks in one response (rare) | Consolidate into a single tool call with batched inputs. |
| **Large-file scan** | N wasted entries listed for a directory | Use `maxDepth=1`, `ignore` patterns, or glob instead of full `list_directory` recursion. |
| **Excessive file ops** | Many low-value Read tool calls in a single step | Batch independent file reads into a single tool call. Read only confirmed-relevant files. |

## 3. Triggering a manual efficiency review

The **`Claude Skills: Efficiency Report`** command in VS Code:
- Reads all `.claude/learning/mcp-usage.jsonl` files across known targets.
- Runs `detectWaste()` + `computeScore()`.
- Writes a fresh `mcp-agent-hints.md`.
- Returns a summary panel (score, grade, top waste items).

You cannot trigger this programmatically from the agent — tell the user to:
1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Search `Claude Skills: Efficiency Report`.
3. Run it, then open `mcp-agent-hints.md` from `~/.claude/learning/`.

## 4. Structural token reduction tools

### `lazy-mcp`
The bundled `mcp-lazy-proxy.js` compresses tool schemas before sending them to
the model. Smaller schemas = fewer tokens per response. It is enabled by default
when the proxy is active.

Key config: `client__mcpServers` entries route through the proxy, which strips
unused properties from tool input schemas (max description length: 100 chars).

### `mcp-compressor`
Use `mcp-compressor` when your tool schemas are large (>1k tokens of schema text)
and many tools are registered. The compressor removes:
- Unused `description` fields from input property schemas.
- Verbose `enum` listings (>10 values).
- Redundant `required` arrays.

Activate via the proxy `lazyMode` config option in the proxy's config JSON.

## 5. Efficiency dashboard KPIs

The dashboard (`Claude Skills: Open Cost Dashboard` → Efficiency panel) shows:
- **Overall score**: 0–100 % across all recorded sessions.
- **Grade bands**: A (≥90 %) · B (70–89) · C (50–69) · D (<50).
- **Trend**: 7-day rolling average to spot regressions.
- **Per-file breakdown**: which files caused the most waste.

Use this after fixing a pattern to confirm the score improved.

## 6. Fixing a known waste pattern (step-by-step)

1. **Read `mcp-agent-hints.md`** → note the files/operations with high waste.
2. **Change one thing at a time** — the engine records improvements per-change.
3. **Verify**: re-run the Efficiency Report → same file should show fewer `reads`.
4. **Commit the fix** if it's repo-visible so teammates also benefit.
