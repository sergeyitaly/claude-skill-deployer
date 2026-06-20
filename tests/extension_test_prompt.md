# Claude Skills Manager — Extension Functionality Consolidation Audit

You are a Senior VS Code Extension Architect, Staff Software Engineer, Performance Engineer, and Technical Product Auditor.

Your task is to review the Claude Skills Manager extension source code and identify:

- Duplicate functionality
- Overlapping features
- Features that solve the same problem twice
- Dead code
- Legacy code
- Unused telemetry
- Unused hooks
- Unused configuration
- Feature bloat
- High-maintenance components
- Features with low value relative to overhead

This is NOT a performance benchmark.

This is NOT a code-quality review.

Your goal is to determine whether the extension has evolved unnecessary complexity and how it can be simplified without losing meaningful value.

---

# Scope

Review the entire extension folder:

extension/

Examples:

- extension.ts
- hookOps.ts
- mcpUsageLog.ts
- efficiencyMetrics.ts
- haceMetrics.ts
- autoOptimizer.ts
- dashboardSnapshotCache.ts
- telemetry modules
- hook registration logic
- dashboard generators
- cost analytics
- HACE analytics
- skill recommendation systems
- skill-gap detector integration
- optimizer components

Review package.json contributions and commands.

Review settings, configuration, feature flags, commands, views, dashboards, telemetry and hooks.

---

# Audit Goal

Answer one question:

"If starting from scratch today, which parts of the extension would we keep, simplify, merge, redesign, or remove entirely?"

---

# Part 1 — Feature Inventory

Create a complete inventory.

For each feature:

Name:

Purpose:

Files:

Dependencies:

Primary data source:

User-visible benefit:

Maintenance complexity:

High / Medium / Low

---

# Part 2 — Duplicate Functionality

Identify places where multiple components solve the same problem.

Examples:

- multiple telemetry systems
- multiple dashboard generators
- multiple recommendation systems
- multiple caches
- multiple learning mechanisms
- multiple analytics calculations

Output:

Feature A:

Feature B:

Overlap:

Recommendation:

Keep A

Keep B

Merge

Remove

---

# Part 3 — Telemetry Review

Review all telemetry-related features.

Examples:

- mcpUsageLog
- terminal-watch
- HACE
- cost metrics
- dashboard snapshots
- efficiency metrics
- recovery metrics

For each:

Purpose:

Unique value:

Data source:

Maintenance cost:

Can it be merged?

Can it be removed?

---

# Part 4 — Hook Review

Review every hook.

Examples:

- SessionStart
- UserPromptSubmit
- PreToolUse
- PostToolUse

For each hook answer:

What user value does it create?

What extension feature depends on it?

How much complexity does it introduce?

Can another hook already provide the same information?

Should it be:

Keep

Merge

Remove

Delay

Make optional

---

# Part 5 — Dashboard Review

Review:

- HACE
- Efficiency dashboard
- Cost dashboard
- Recovery dashboard
- Telemetry dashboard

Determine:

Which metrics are truly actionable?

Which metrics are interesting but not useful?

Which metrics nobody would realistically use?

Which metrics duplicate each other?

Provide recommendations.

---

# Part 6 — Learning System Review

Review:

- self-learning
- skill-feedback-adaptation
- task-skill-proposals
- autoOptimizer

Determine:

Which components actually improve agent outcomes?

Which components create maintenance burden?

Which components are difficult to explain to users?

Which components overlap?

Recommendation:

Keep

Merge

Simplify

Remove

---

# Part 7 — Configuration Review

Review:

settings

feature flags

activation options

commands

configuration keys

Determine:

Which settings are essential?

Which settings are rarely needed?

Which settings should become advanced-only?

Which settings create confusion?

Output:

Current Count:

Recommended Count:

---

# Part 8 — Complexity vs Value Matrix

For every major feature calculate:

User Value:
1-10

Engineering Cost:
1-10

Maintenance Cost:
1-10

Telemetry Cost:
1-10

Result:

High Value / Low Cost

High Value / High Cost

Low Value / High Cost

Low Value / Low Cost

---

# Part 9 — Technical Debt Review

Identify:

Dead code

Unused exports

Unused commands

Unused settings

Legacy logic

Deprecated behavior

Features superseded by newer implementations

Output:

File:

Issue:

Recommendation:

---

# Part 10 — If We Had To Cut 50% Of The Extension

Assume the extension became too large.

You must reduce:

- code size
- maintenance burden
- telemetry overhead
- support burden

by approximately 50%.

List exactly:

1. Features to keep no matter what
2. Features to simplify
3. Features to merge
4. Features to remove

Explain why.

---

# Part 11 — Target Architecture

Design a lean v2 architecture.

Goal:

Maximum value

Minimum complexity

Minimum telemetry overhead

Minimum configuration

Minimum maintenance

Provide:

Current Architecture

Lean Architecture

Migration Plan

Benefits

Risks

---

# Final Deliverables

1. Top 10 most valuable features
2. Top 10 least valuable features
3. Top 10 simplification opportunities
4. Estimated reduction in:
   - code complexity
   - telemetry volume
   - hooks
   - configuration
   - maintenance effort
5. Final verdict:

"Which parts of Claude Skills Manager are essential and which parts have become unnecessary complexity?"