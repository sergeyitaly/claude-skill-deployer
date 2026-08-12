---
name: task-evidence-report
description: Produce an evidence-based explanation of what was actually done on a task — real diffs, real test output, real command results, optionally with diagrams — instead of a confident-sounding summary built from memory or assumption. Use when the user needs to explain, defend, present, or hand off completed work to someone else (a reviewer, a manager, a teammate, themselves later), when asked for "proof", "докази", "презентацію що було зроблено", "explain what changed and why", or before closing out a task that involved several commits/approach changes. Explicitly built to survive a skeptical reviewer, not to look finished.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - Artifact
---

# Task Evidence Report

## Why this exists

Built after a real, costly failure: presenting AI-assisted work in a way that
sounded complete, but that the person presenting it couldn't defend when
asked to explain or prove it themselves. The work may have been fine — the
explanation wasn't grounded in anything checkable, so it didn't survive
scrutiny, and the person delivering it paid for that, not the agent that
wrote it.

The standard this skill has to meet: **every claim needs an attached piece of
evidence a skeptical person could check themselves** — a file:line, a real
command and its real output, a specific test name and its actual result. Not
"tests pass" — the actual test run, right now, not a remembered one. Not "the
fix works" — the specific line that proves it, and what would have shown if
it didn't.

Do not write this for a reader who will take it at face value. Write it for
one who will ask "show me," and design every section so that when they do,
the answer is already there — not "let me check."

## 1. Gather real evidence — never from memory

Re-derive everything from source, right now, even if you (or an earlier
message in this conversation) already stated it. A claim repeated from
memory is not evidence, even if it was true when first observed.

- `git log`, `git diff`, `git show` for the actual commits in scope — not a
  paraphrase of what you intended to commit.
- **Run the tests now.** If a test suite exists, run it and quote real
  output (pass/fail counts, the actual failing assertion if any) — never
  reuse a result from earlier in the conversation without re-running it,
  since a change since then could have broken it silently.
- For every "fixed X" claim, cite the specific file and line(s) that fix it.
  If you can't point to one, the claim doesn't belong in the report as
  "fixed" — say what's actually true instead (attempted, partially done,
  unverified).
- If a build/compile/package step matters, actually run it and check the
  output artifact contains the change (e.g. grep the compiled file) —
  don't assume compiling succeeded because editing didn't error.
- Quote real command output, not a summary of it. `npm test: 958/958 passed`
  is evidence. "All tests pass" is a claim.

## 2. Check for leftover code from an earlier approach

This is the specific failure mode numerous commits can hide: the team (or
the agent) tried approach A, partially built it, then switched to approach
B — and A's remnants (an unused function, a dead branch, an orphaned file,
a config flag nothing reads anymore) are still sitting in the codebase,
invisible in a diff of the final state alone.

- List every commit in the task's scope (`git log --oneline` over the
  relevant range) and note anywhere the approach visibly changed direction
  (a revert, a "actually let's do X instead" message, a rewritten function).
- For each such pivot, actively search for remnants of the abandoned
  approach: grep for symbols/functions/files it introduced, check they were
  actually removed or are still correctly wired into the final approach —
  don't assume a later commit fully cleaned up after an earlier one just
  because the task "looks done."
- Confirm the tests being run actually exercise the *final* approach, not
  stale tests written against the earlier one that happen to still pass for
  unrelated reasons.
- If you find leftover remnants, report them plainly as a finding — that is
  exactly the kind of thing this report exists to surface, not to hide.

## 3. Build the explanation

Structure, in order:

1. **What was actually asked.** Quote or closely paraphrase the real
   request — not a cleaned-up version of it.
2. **What was tried**, including dead ends. A wrong turn that was corrected
   is honest history and usually proves more real engagement with the
   problem than a straight line to success would. Don't edit failed
   attempts out to make the story look cleaner than it was.
3. **What the final state is** — each claim paired with its evidence from
   step 1, inline, not batched into an unverified summary at the end.
4. **What was NOT done, or couldn't be verified.** State this as plainly as
   the successes. A report with no unresolved edges reads as unexamined,
   not as complete — real work almost always has at least one open
   question.

## 4. Diagrams — only when they carry real information

Use a diagram (Mermaid, via the `artifact-diagramming` skill if publishing
as an Artifact) when it shows a mechanism that would take several sentences
to describe accurately: a before/after architecture change, the actual
sequence of calls in a bug's reproduction, a timeline of the commits/pivots
from step 2. Do not add a diagram to make the report look more finished —
if it doesn't change what the reader understands, cut it.

## 5. Language and tone

- No inflated confidence words ("seamlessly", "robust", "production-ready",
  "fully resolved") unless a specific check backs the exact claim being
  made. If the check is partial, say partial.
- Short, plain sentences. No padding, no restating the same point in a
  closing summary — if it was said once with evidence, it doesn't need to
  be said again without it.
- Ground the framing in the *actual* conversation that happened — the real
  back-and-forth, the user's own corrections, what they pushed back on —
  not a generic templated project-report voice. If this conversation
  disagreed with an approach and changed course, that's part of the honest
  record, not something to smooth over.
- Never claim collaboration, agreement, or review that didn't happen. If
  the human hasn't looked at something yet, say that, don't imply otherwise.
- This is one shared piece of work, not the agent's output being handed
  across a wall to a human who's expected to just accept it. Write so the
  person presenting it could defend every line themselves, in their own
  words, if asked a follow-up question — that's the actual bar, not
  "sounds finished."

## 6. Output format

Default to a plain in-chat explanation — most of the time that's what's
actually needed, and it's easier for the person to absorb and be able to
restate themselves. Only build a published Artifact (HTML, with diagrams)
when it genuinely needs to be shareable with someone else (a manager, a
reviewer, a teammate who wasn't in this conversation) — load the
`artifact-design` skill first per its own instructions, and keep it
evidence-first and visually calm, not a marketing-style slide deck.

## 7. Before showing it to the user — self-check

- Does every "done"/"fixed" claim have an attached, checkable piece of
  evidence sitting right next to it?
- Is anything you couldn't verify labeled as such, instead of implied to be
  fine?
- Did you actually check for leftover code from an earlier approach in this
  same task, not just assume the latest commit cleaned everything up?
- If the person reading this re-ran the tests or the commands themselves
  right now, would they get what this report says they'd get?
- Does the tone match how this conversation actually went, or does it read
  like a generic AI-generated status report?

If any answer is no, fix that before sending it — that gap is exactly what
this skill exists to close.

## Hand-offs

- Diagram mechanics (Mermaid syntax, layout, legibility in both themes) →
  [[artifact-diagramming]].
- Page design calibration before publishing as an Artifact →
  `artifact-design` (load per its own instructions).
- A parallel case of the same "recorded/claimed vs. actually observed"
  discipline, applied to auditing whether a tool delivers real value rather
  than to explaining a completed task → [[extension-value-audit]].
