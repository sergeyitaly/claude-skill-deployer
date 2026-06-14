# Extension benchmarks (reconciled)

Two complementary harnesses — use both:

| Command | What it measures | Real agent tokens? |
|---------|------------------|-------------------|
| `npm run bench:complete` | Full extension stack (pipeline, hooks, adaptation) + complex fixture **deployment** metrics | Optional (`ANTHROPIC_API_KEY` in subprocess) |
| `npm run bench:skill-impact` | Live Claude CLI A/B: with skills vs `--disable-slash-commands` | **Yes** — `claude -p --output-format json` |

They answer different questions:

- **bench:complete** — Is the extension fast and healthy on *your* workspace? Does it route the right skills for CI/ADX work?
- **bench:skill-impact** — What does skills loading cost in **real dollars and tokens**? What diff does the agent produce?

---

## 1. Complete complex benchmark (`bench:complete`)

```powershell
cd extension
npm run bench:complete
```

Measures: hot paths, cost pipeline, dashboard caches, hooks (4 agents), task proposals, complex agent harness (`agent-comparison-fixture-complex/`).

Results: `scripts/complete-benchmark-results/complete-<timestamp>.json|md`

| Env | Effect |
|-----|--------|
| `BENCH_SKIP_AGENT=1` | Skip complex harness subprocess |
| `ANTHROPIC_API_KEY` | Live Haiku API in harness (optional) |

---

## 2. Skill impact benchmark (`bench:skill-impact`) — validated CLI harness

Runs the **same task twice** in disposable git worktrees via Claude Code CLI:

1. **With skills** (default — extension skill catalog loaded)
2. **Without skills** (`claude --disable-slash-commands`)

```powershell
cd extension
npm run bench:skill-impact                              # minimal "reply OK" — catalog overhead
npm run bench:skill-impact:complex                      # CI validate + ADX KQL fixture task
npm run bench:skill-impact -- --task "your prompt here"
npm run bench:skill-impact -- --task-file path/to/TASK.md
npm run bench:skill-impact -- --dry-run                 # print commands without API calls
```

Works on **Windows (PowerShell)** and POSIX — uses `node scripts/benchmark-skill-impact.mjs` (no bash required).
The legacy `benchmark-skill-impact.sh` remains for manual use on Linux/macOS.

Results: `scripts/bench-results/<run-id>/report.md` (+ JSON, diffs, logs)

### Validated JSON fields (use `modelUsage` on budget cutoff)

From `claude -p --output-format json`:

- `usage` — top-level tokens (may zero out on `error_max_budget_usd`)
- **`modelUsage`** — per-model breakdown; **always sum this when budget cuts off**
- `total_cost_usd`, `num_turns`, `errors`, `result`

### Known data point (trivial "reply OK" task)

| Arm | Cost | Notes |
|-----|------|-------|
| With skills | ~$0.077 | Mostly cache-creation tokens from skill catalog |
| Without (`--disable-slash-commands`) | ~$0.029 | No catalog load |

Default `--max-budget-usd` is **2.00** (raised from 0.50 so catalog load does not false-fail the with-skills arm).

### Gitignored artifacts

- `.bench-tmp/` (worktrees) — repo root `.gitignore`
- `extension/scripts/bench-results/` — `extension/.gitignore`

---

## When to use which

| Goal | Use |
|------|-----|
| Extension perf SLAs on your repo | `bench:complete` |
| Skill routing / proposals for CI+ADX | `bench:complete` |
| Real token $ cost of skills loaded | `bench:skill-impact` (default task) |
| Quality + cost on complex fixture | `bench:skill-impact:complex` |
| Custom repo task | `bench:skill-impact -- --task-file ...` |
| **Auto-tier team benefit % vs no extension** | `bench:tier-benefits` |

`bench:complete` does **not** replace `bench:skill-impact` for live CLI token accounting — fold both into your workflow rather than picking one.

---

## 3. Tier benefit benchmark (`bench:tier-benefits`) — auto-tier vs no extension

Compares three arms on **your workspace**:

| Arm | Meaning |
|-----|---------|
| **no-extension** | Baseline — $0 extension overhead, 0% team capability from tier features |
| **naive-full-stack** | Extension always on `team-multi-agent` (worst-case overhead) |
| **auto-detected** | Tier from local git/repo signals (what the extension picks today) |

```powershell
cd extension
npm run compile
npm run bench:tier-benefits
# optional remote git probe arm:
$env:BENCH_TIER_PROBE_REMOTE = "1"
npm run bench:tier-benefits
```

Results: `scripts/tier-benefit-results/tier-benefits-<timestamp>.json|md`

### Team metrics reported

| Metric | Meaning |
|--------|---------|
| **Net team benefit index** | 60% capability retained + 40% overhead saved vs naive full stack |
| **Capability retained** | % of full-stack team features kept at auto tier |
| **Overhead savings** | % extension $/mo saved vs always running team-multi-agent |
| **Uplift vs no extension** | Team capability % gained by having the extension at auto tier |
| **Efficiency index** | Capability normalized by monthly overhead (higher = better ROI) |

Measured live per arm: cost pipeline p50/skipped, multi-agent sync gate, feature count enabled.

Use this for Marketplace demos, team ROI slides, and “why auto-tier matters” narratives — pair with `bench:skill-impact` when you also need **real Claude CLI token dollars**.
