---
name: cost-attribution-setup
description: Configure and troubleshoot cost attribution — how skill-invoke hooks feed runs.jsonl, what confidence scores mean, how system mode gates optimizers, and when to run Reset Mis-attributed Cost Data. Use when asked "why is my cost low-confidence", "how do I enable cost tracking", "degraded/safe mode", or "reset misattribution".
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - mcp__filesystem__read_file
  - mcp__filesystem__write_file
---

# Cost Attribution Setup

This extension uses **Attribution v2** hooks to record per-skill cost in
`runs.jsonl`, confidence scoring to grade reliability, and a system-mode
circuit to gate the optimizer when data is too noisy to act on.

## 1. Attribution v2 data pipeline

Each tool-use completion emits a PostToolUse hook event. The attribution logic
tags events with:
- `source: "skill-invoke-hook-v2"` (when captured from the hook server).
- `skill`, `agent`, `session_id`, `cost`, `tokens`.

### How the hook server integrates
The `hookHandlers.ts` in the VS Code extension registers guards including
`skill-invoke-hook-v2`. The `hookOps.ts` bootstraps the hooks and ensures the
hook server is reachable. If the hook server is not running, attribution degrades
to `heuristic` source (equal-split costs).

### Confidence levels

| Level | Score range | What it means | How to improve |
|---|---|---|---|
| `high` | ≥ 0.75 | Strong attribution — per-skill costs are reliable. | Nothing needed. |
| `estimated` | 0.45 – 0.749 | Partial data — some skills use heuristics or transcript split estimates. | Run more sessions; ensure hook server is healthy. |
| `low` | < 0.45 | Unreliable — too many sessions lack per-skill hooks. | Check `hook server not running` guard status; regenerate usage. |

A per-skill confidence entry lives at `runsStore.ts` and is exposed in the
dashboard and usage report.

## 2. System mode

`SystemMode = "normal" | "degraded" | "safe"` determines what the optimizer is
allowed to suggest:

| Mode | Condition | Optimizer actions allowed |
|---|---|---|
| `normal` | Confident attribution + fresh pipeline | canApplyOptimizations = true |
| `degraded` | Confident but lower score (0.45–0.75) | canSuggestOptimizations = true; cannot auto-apply |
| `safe` | Attr confidence <0.45, equal-split mis-attribution, or stale pipeline | cannot suggest or apply optimizations |

The trust banner in the Cost Dashboard shows this status. Clicking it reveals
the detailed signals (stale equal-split, high unattributed ratio, pipeline age).

## 3. Resetting misattributed cost data

When the heuristics produce stale equal-split costs (a common legacy pattern
from pre-v2 sessions), use:

**VS Code command:** `Claude Skills: Reset Mis-attributed Cost Data`
(or call `resetMisattributedData(target)` from TypeScript).

This:
1. Recomputes per-skill attribution from `runs.jsonl` using the Tag API.
2. Falls back to an empty equal-split entry only when no tag data exists.
3. Writes back the `cost-attribution.json` for each target.

The result object tells you how many rows were updated and whether the old
equal-split fallback was applied. After resetting, the system mode should
improve from `safe` → `degraded` or `normal` (if enough hook data exists).

### When to reset
- Trust banner says "Equal-split mis-attribution detected".
- Trust banner says "Legacy unattributed bucket inflated (pre-1.0.49 collector)".
- Per-skill costs look suspiciously equal (e.g., every skill shows exactly
  the same dollar figure).
- The Optimizer button is disabled with `title="Paused in safe/degraded mode"`.

## 4. Checking your attribution health

Open the Cost Dashboard (`Claude Skills: Open Cost Dashboard` → trust banner).

### Healthy: green badge
- Confident score ≥ 75 %.
- v2 hook runs cover >80 % of sessions.
- No equal-split detected.
- Pipeline age < 24 h.

### Degraded: yellow badge
- Confident score 45–74 %.
- Fewer hook runs; expect `estimated` confidence for most skills.
- Optimizer can suggest but not auto-apply.

### Broken: red badge
- Confident score < 45 %.
- Hook server unreachable or almost-all sessions are `heuristic`.
- `safe` mode — optimizer is disabled.

### How to improve
1. Ensure the extension host is active (watch for hook echo in the Output panel).
2. Open each workspace once (triggers session start hook firing).
3. Wait for the pipeline scheduler to regenerate usage (default: hourly).
4. Re-check the trust banner after the next refresh.

## 5. Attribution data files

| File | Role |
|---|---|
| `~/.claude/learning/runs.jsonl` | Primary audit log — hook rows tagged `skill-invoke-hook-v2`. |
| `~/.claude/learning/cost-attribution.json` | Per-target per-skill aggregated costs (written by the pipeline). |
| `~/.claude/learning/skill-stats.json` | Cached per-skill token/cost totals (used by usageStats). |
| `~/.claude/learning/daily-stats.json` | Sub-daily aggregation for graph views. |

All paths are workspace-scoped via the workspace hook config; the extension
uses `workspaceMcpLogPath()` to resolve per-workspace targets.
