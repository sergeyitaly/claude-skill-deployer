# LinkedIn launch announcement templates — v1.0.0

Replace `[LINK]` with your Marketplace URL:
`https://marketplace.visualstudio.com/items?itemName=serhiivoinolovych.claude-skill-deployer`

---

## Template A — Short announcement (recommended)

**Headline post**

```
Shipped v1.0.0 of Claude Skills Manager on the VS Code Marketplace.

If you use Claude Code (or Cursor) on real projects, you have probably felt this: the right skills save hours, but the wrong ones burn credits fast — and nobody shows you the bill per skill.

This extension fixes that loop:

→ Auto-detect which skills match your repo (Terraform, Azure, CI, ADX, …)
→ Deploy one shared library to Claude, Cursor, Kiro, and Copilot
→ Daily budget + emergency cutoff so spend does not run away
→ Cost Intelligence Dashboard: which skills cost what, and what to disable

v1.0.0 adds onboarding in under 2 minutes, self-healing data repair, and per-feature toggles so you only enable what you need.

Free · MIT · 17 bundled skills · VS Code 1.85+

Install: [LINK]

Would love feedback from teams sharing .claude/skills/ in git — especially on branch profiles and git-author cost attribution.

#ClaudeCode #Cursor #VSCode #AIEngineering #DeveloperTools
```

---

## Template B — Story / problem-solution

```
Last month I kept asking one question on every Claude Code session:

"Was that $0.40 worth of context from terraform-plan-review, or could Cursor have handled it?"

There was no dashboard. No per-skill attribution. No budget guardrail when I left 12 skills enabled on a small repo.

So I built Claude Skills Manager — now at v1.0.0 on the VS Code Marketplace.

What it does:
• Detects your stack and installs only relevant skills from a curated library
• Tracks estimated spend per skill across Claude + Cursor transcripts
• Suggests optimizations (disable expensive idle skills, switch agents)
• Optional daily budget, economy mode, and hard emergency cutoff

For teams: see who added an expensive skill via git blame on .claude/skills/.

I use it daily on Azure/Terraform/GitLab projects. Early adopters reported 30–50% savings when they turned on auto-optimization (opt-in).

Try it: [LINK]
Repo: https://github.com/sergeyitaly/claude-skill-deployer

What would you want next — PR cost comments, team benchmarks, or something else?

#AI #DevTools #Claude #CostOptimization
```

---

## Template C — Technical audience (architects / platform engineers)

```
v1.0.0 — Claude Skills Manager (VS Code extension)

Architecture in one paragraph:
skills_library/ (manifest + detect_globs) → deploy targets in agents.json → per-workspace .claude/skills/ (git) + personal overrides in settings.local.json (gitignored). Attribution merges runs.jsonl with background transcript parsing from ~/.claude/projects and ~/.cursor/projects.

Production features:
✓ Feature flags for every major subsystem
✓ Attribution dedup (session + mtime)
✓ Migration backup .claude/backup-v0.7/
✓ validate-release.mjs before publish
✓ CLI parity: generate_skills.py cost-report

Not another prompt pack — operational controls for skill sprawl and credit visibility.

Marketplace: [LINK]

Happy to compare notes if you are standardizing agent skills across a platform team.
```

---

## Template D — Comment reply (when someone asks "what is this?")

```
It is a VS Code extension + Python CLI that manages Claude Code "skills" (SKILL.md instruction packs): detects what your repo needs, installs from a bundled library, and shows estimated cost per skill. v1.0.0 adds budget limits and a cost dashboard. [LINK]
```

---

## Template E — Follow-up post (1 week after launch)

```
One week since Claude Skills Manager v1.0.0:

• [X] Marketplace installs (update manually)
• Top feature used: Cost Intelligence Dashboard / onboarding tour (update from telemetry if enabled)
• Most requested: [fill from issues]

If you hit a rough edge — corrupted runs.jsonl, false emergency cutoff, large transcript repos — there is a Repair Data command and we are prioritizing hotfixes.

Thank you to everyone who tried it and opened issues.

[LINK]
```

---

## Tips for LinkedIn

1. Attach **screenshot-dashboard.png** from `extension/images/` when captured.
2. Post Tuesday–Thursday morning in your timezone for B2B dev tools.
3. Pin the Marketplace link in the first comment if the post editor strips URLs.
4. Tag colleagues who run Claude Code on infra repos — concrete use case beats generic AI hype.
5. Do not paste Marketplace PATs or internal budget numbers in public posts.
