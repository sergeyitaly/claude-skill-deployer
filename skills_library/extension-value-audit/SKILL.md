---
name: extension-value-audit
description: Give an honest, evidence-based verdict on whether the "Claude Skills Manager" VS Code extension (claude-skill-deployer) is actually delivering real value in THIS project — not a usage-count report of individual skills (see skill-usage-insights for that), but a judgment of the extension's own core mechanisms (adaptive skill suggestions/confidence scoring, task-focus, budget/cost gating, MCP-Force security mode, cross-agent sync, hooks pipeline) against real .claude/learning/ telemetry and the agent's own actual session experience. Use when asked "is this extension helping", "give feedback on Claude Skills Manager", "extension ROI", "does the extension actually do anything", "audit the extension's value", or similar. Produces a blunt, numbers-grounded report — not marketing copy.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
---

# Extension Value Audit

A verdict on whether the **Claude Skills Manager** VS Code extension
(`claude-skill-deployer`) is doing anything real in *this* project — grounded
in this project's own recorded telemetry plus what you, the agent running
this skill, can actually recall observing in your own session. This is not a
per-skill usage report (that's [[skill-usage-insights]]); it audits the
extension's own machinery: adaptive recommendations, task-focus, budget
gating, MCP-Force Mode, cross-agent sync, and its hooks pipeline.

**Do not be diplomatic for its own sake.** "This did nothing observable" is a
legitimate, acceptable conclusion if the evidence says so. The point of this
skill is to catch exactly the failure mode where a mechanism runs, writes
data nobody reads, and nobody ever notices — that pattern has been the single
most common finding in this extension's own reliability history. Padding a
negative finding with hedging defeats the purpose.

## 1. What the extension claims to do

Judge everything below against these stated goals — not against "is
telemetry present," which is a much lower bar:

- **Adaptive skill installation/recommendation.** Detects the project's
  stack and proposes/installs relevant skills, with a confidence score that's
  supposed to improve as it learns what gets accepted vs. ignored.
- **Task-focus.** Keeps only skills relevant to the *current* task loaded,
  auto-disabling the rest, so the agent isn't carrying dead weight in context.
- **Budget/cost gating.** Tracks spend and can auto-disable expensive
  ("high-tier") skills once a threshold is crossed.
- **MCP-Force Mode.** A security posture that routes file/shell access
  through an allow-listed MCP filesystem server instead of raw native tools.
- **Cross-agent sync.** Keeps skill sets and config consistent across Claude
  Code, Cursor, Kiro, and GitHub Copilot when a project uses more than one.
- **Dashboards/visibility.** A cost/usage dashboard, and (in newer versions)
  a session-end summary — the extension's own attempt to make its telemetry
  actually reach the user instead of sitting unread in a `.jsonl` file.

Not every project will have every mechanism configured — check what's
actually present (step 2) rather than assuming the newest feature set.
Schemas have changed across versions; if a field or file mentioned below is
absent, that's data, not an error — note the extension version if
`package.json` or an installed skill's metadata reveals it.

## 2. Gather real evidence

All under `.claude/` in this project. Read what exists; note plainly what
doesn't (absence is itself a finding, e.g. "MCP-Force configured but zero
usage log entries ever" is worse than "not configured at all").

- **`.claude/settings.json`** — the ground truth for what's actually wired
  up: which hooks are registered (`PreToolUse`/`PostToolUse`/`SessionStart`/
  `UserPromptSubmit`/`Stop`), against which tool matchers, pointed at which
  local endpoint. Count how many separate hook entries fire per ordinary tool
  call (e.g. a `Read` matched by both `PreToolUse` and `PostToolUse` against
  the same route is 2 subprocess+network round trips per call, not 1) —
  this is the extension's real per-call overhead, and it's usually invisible
  unless someone reads this file directly. Also check `permissions.deny` for
  MCP-Force Mode and any budget/task-focus config blocks.
- **`.claude/settings.local.json`** — `skillOverrides`: skills task-focus has
  silently disabled. Cross-check against what's actually installed in
  `.claude/skills/` — a mismatch here (skill installed, override says off,
  no record of why) is a real gap worth naming.
- **`.claude/learning/runs.jsonl`** — per-invocation records: skill, cost,
  success, session_id, timestamps. This is the closest thing to ground truth
  for "did the extension's tracked skills actually get used, and did they
  work."
- **`.claude/learning/hook-health.jsonl`** — hook firing events; on newer
  extension versions also `hook_request` records with a `durationMs` field
  (server-side hook latency). If this file has zero `durationMs` values
  anywhere, say explicitly: this project has no visibility into whether the
  hook pipeline is ever slow — that is a real, checkable blind spot, not
  speculation.
- **`.claude/learning/task-skill-proposals.json`**, **`recommendation-feedback.jsonl`**,
  **`proposalOutcome.jsonl`** — did the adaptive-recommendation engine
  actually propose skills that got *accepted* (invoked), or mostly ones that
  got silently ignored? A high proposal count with a near-zero accept rate
  means the "adaptive" part isn't adapting to anything useful.
- **`.claude/learning/confidence-history.jsonl`**, **`skill-adoption.jsonl`** —
  evidence the scoring/adoption engine is *running* (file exists, growing).
  Running is not the same as *mattering* — see step 3.
- **`.claude/learning/model-routing.jsonl`** — if present, every prompt's
  scenario/tier classification. A large file here with no corresponding
  memory of ever seeing a model-tier suggestion in-session is worth flagging.
- **`.claude/learning/mcp-usage.jsonl`**, **`allowed-dirs.json`** — real
  evidence MCP-Force Mode's filesystem server is actually being exercised,
  vs. configured-but-dormant. Scan for near-duplicate consecutive records
  (same tool, same path, timestamps within ~1s) — a rough smell test for a
  Pre/Post double-write bug on extension versions that don't dedupe it.
- **`.claude/learning/dashboard-snapshot.json`**, **`skill-stats.json`** —
  precomputed aggregates, if present; useful for quick totals without
  re-deriving them by hand.
- **`.claude/learning/extension-output.log`** — the extension's own debug
  log mirror, if the installed version has it; useful for catching silent
  errors the `.jsonl` files wouldn't show.

## 3. The actual audit: recorded vs. observed

This is the step that separates a real audit from reading a dashboard out
loud. For each mechanism in step 1:

1. **Recorded** — does the telemetry show it ran (proposals generated,
   task-focus overrides written, budget checks logged, MCP usage entries)?
2. **Observed** — think back over *this session's own transcript*, not the
   files. Did you, the agent, ever actually see a system-reminder, injected
   context block, notification, or behavior change that you can point to as
   caused by this extension — as opposed to Claude Code's/Cursor's/Kiro's own
   native skill-listing, which exists with or without this extension
   installed? Be specific: "I saw a system-reminder block listing installed
   skills" is NOT evidence of the adaptive/confidence layer working — that
   listing is the harness's native behavior. Evidence would be something
   like an injected proposal with a confidence score, a task-focus disable
   notice, a budget warning, or an end-of-session summary toast.
3. **Gap or match?** A mechanism can be Recorded=yes, Observed=no — that's
   the single most important thing this skill exists to catch (it's this
   extension's own most common bug class: something runs, writes real data,
   and produces zero visible effect). Say so plainly when it happens; don't
   soften it into "may need further investigation."
4. **Hidden cost check.** Regardless of benefit, name the real cost: hook
   count per tool call from step 2, any measured or estimated latency, any
   duplicate-write evidence, file sizes in `.claude/learning/` that suggest
   meaningful disk/parse overhead accumulating with no corresponding use.

Give real numbers wherever the data supports them (invocation counts,
proposal accept-rate, cost totals, hook-call multiplier per tool call,
measured latency if available) — not "seems active" or "looks healthy."

## 4. Output format

1. A short table: mechanism (from step 1) | Recorded? | Observed this
   session? | Verdict (working / dormant / configured-but-silent / not
   configured).
2. 2-4 bullets of hidden-cost findings from step 3.4, with real numbers.
3. One blunt closing paragraph: does this extension earn its keep in *this*
   project, given what it claims to do vs. what actually reached the agent
   or the user? If the honest answer is "mostly invisible telemetry with no
   observable behavior change," say that directly — that's a valid and
   useful verdict, not a failure to find something nicer to say.
4. Explicitly list what you could **not** verify (e.g. "whether the
   confidence score ever changed which skill I picked" lives in the agent's
   own reasoning, not in any log — say so rather than guessing either way).

## 5. Hand-offs

- Per-skill usage/KPI numbers (which *installed skills* are active, failing,
  unused) → [[skill-usage-insights]] — different question, complementary
  report.
- If this audit finds a real bug or gap in the extension itself, that's a
  fix for the `claude-skill-deployer` repo's own maintainers/session, not
  something this skill (running in an unrelated consumer project) can act
  on directly — report it, don't attempt to patch the extension's source
  from here.
