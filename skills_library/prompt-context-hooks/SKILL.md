---
name: prompt-context-hooks
description: Understand how the prompt-context-watch.js hook controls context grounding and practical focus injection. Use when asked "how does context grounding work", "how do I disable prompt injection", "what does practical focus do", "configuring session size warnings", or when modifying this extension's hook system.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Glob
---

# Prompt Context Hooks

All prompt-time context injection is now handled by a single hook file:
`extension/resources/hooks/prompt-context-watch.js` (merged in v1.0.81 from
`context-focus-watch.js`, `practical-focus-watch.js`, and
`session-size-watch.js`).

One composed message is emitted per `UserPromptSubmit` instead of three
separate hook firings, reducing duplicate overhead.

## 1. `context-focus.json` — grounding level

**Config path:** `~/.claude/learning/context-focus.json`
or via VS Code setting `claudeSkills.hooks.contextFocus.level`.

Levels (least → most restrictive):

| Level | Behavior |
|---|---|
| `knowledge` | General model knowledge is acceptable for concepts. |
| `balanced` | Verify repo-specific claims by reading files. |
| `local-first` | Read files and cite paths before explaining behavior. |
| `strict-local` | Only assert facts from files read this session or user messages. |

Other keys:
- `enabled` (bool, default `true`) — toggle injection on/off.
- `autoEscalateOnSessionSize` (bool, default `true`) — tighten grounding when
  the transcript exceeds thresholds.
- `injectEveryPrompt` (bool, default `true`) — when `false`, injection fires
  only on large sessions or session start.
- `limitSkillCatalogHints` (bool, default `true`) — remind agent to load only
  task-relevant skills when many are installed.
- `manySkillsThreshold` (number, default `12`) — threshold above which
  catalog-limit hints apply (local-first and above only).

### Session size escalation

When `autoEscalateOnSessionSize` is on, the hook monitors transcript size:
- `warn` at 4 MB / 100k tokens → tighten grounding one level.
- `critical` at 10 MB / 200k tokens → tighten to `strict-local`.
- Escalation is per-session; it reverts on `/clear` or new session.

## 2. `practical-focus.json` — deployment guidance

**Config path:** `~/.claude/learning/practical-focus.json`
or via VS Code setting `claudeSkills.hooks.practicalFocus.level`.

Levels:

| Level | Behavior |
|---|---|
| `off` (not a level, set `enabled: false`) | No injection. |
| `exploratory` | Trade-offs and theory are fine; note deployment risks. |
| `balanced` | Pair explanations with concrete next steps tied to this repo. |
| `architecture-first` | Read IaC, CI/CD, and deployment docs before advising. |
| `deploy-ready` | Every recommendation must be executable: exact commands,
  file paths, validation steps. |

Other keys:
- `enabled` (bool, default `false`) — off by default; opt in when working on
  infra or deployment work.
- `level` (string, default `architecture-first` when enabled).
- `injectEveryPrompt` (bool) — same semantics as context-focus.
- `recommendDeploymentSkill` (bool) — hint to trigger deployment-related
  skills when the user mentions production.
- `requireValidationSteps` (bool) — enforce `terraform fmt/validate/plan`,
  `npm test`, `az deployment group validate`, etc. before claiming success.

### Disabling injection for a session

Set `injectEveryPrompt: false` in either config file. The hook then only
injects context at session start or when session size triggers escalation.

Direct override: write `~/.claude/learning/context-focus-state.json` with
`{ "injectEveryPrompt": false }` for the current session only.

## 3. Hook registration

The extension's `hookOps.ts` installs `prompt-context-watch.js` as the sole
hook for three legacy event slots:
- `session-size` (SessionSizeChanged)
- `context-focus` (UserPromptSubmit)
- `practical-focus` (UserPromptSubmit)

On install, the hook server deregisters any legacy files
(`session-size-watch.js`, `context-focus-watch.js`,
`practical-focus-watch.js`) to avoid double-firing.

## 4. How the hook builds its output

The hook reads its two config files (`context-focus.json` and
`practical-focus.json`) from disk on each `UserPromptSubmit` call. It:
1. Checks session size and auto-escalation state.
2. Looks up the current grounding level (may be escalated).
3. Looks up the practical-focus level (may be off).
4. Composes a single heading-per-section message.
5. Writes to stdout for `PreToolUse` / writes via `writePromptOutput`
   for `UserPromptSubmit`.

Both config files are hot-reloaded: edit them and the next agent turn picks up
the new value without restarting the extension.

## 5. Troubleshooting

- **No grounding or practical focus messages:** check `injectEveryPrompt` is
  `true` (or session is large enough to trigger auto-escalation).
- **Messages too aggressive:** raise the level — e.g., from
  `strict-local` to `local-first`.
- **Script spawn failures on Windows:** ensure node is on PATH (check with
  `where node` from PowerShell).
- **Double messages in agent output:** a stale legacy hook file is still
  installed. Run `Claude Skills: Reinstall Hooks` in the Command Palette.
