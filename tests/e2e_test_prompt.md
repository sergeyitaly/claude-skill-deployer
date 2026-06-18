You are a Senior Staff Software Engineer, DevOps Architect, Security Reviewer,
QA Lead, VS Code Extension Reviewer, MCP Protocol Reviewer, and FinOps Auditor.

Perform a COMPLETE end-to-end audit of this repository.

Do NOT provide a high-level review.

Perform a deep technical verification.

Assume this project may be released publicly via:

- Visual Studio Marketplace
- Open VSX
- Cursor
- Kiro

Your goal is to identify:

- bugs
- design flaws
- security issues
- MCP issues
- observability gaps
- cost-attribution inaccuracies
- performance bottlenecks
- dead code
- documentation mismatches
- test coverage gaps
- release risks

Use repository contents as source of truth.

Do not rely on README claims alone.

Verify implementation.

--------------------------------------------------
PHASE 1 â€” REPOSITORY INVENTORY
--------------------------------------------------

Analyze:

- folder structure
- major subsystems
- extension activation
- CLI commands
- MCP servers
- hooks
- skills library
- telemetry pipeline
- cost intelligence pipeline

Produce:

- architecture map
- dependency graph
- critical execution paths

--------------------------------------------------
PHASE 2 â€” INSTALLATION & ONBOARDING
--------------------------------------------------

Verify:

- fresh install experience
- VS Code install
- Cursor install
- Kiro install
- Open VSX packaging
- VS Marketplace packaging
- first-run onboarding
- migration logic

Look for:

- broken commands
- missing assets
- missing docs
- activation failures

--------------------------------------------------
PHASE 3 â€” SKILL DETECTION ENGINE
--------------------------------------------------

Audit:

generate_skills.py

Verify:

- manifest parsing
- skill detection logic
- detect_globs behavior
- missing skill detection
- manifest consistency

Check:

- every skill folder exists
- every manifest skill exists
- no orphaned skills
- no unreachable skills

--------------------------------------------------
PHASE 4 â€” MULTI-AGENT DEPLOYMENT
--------------------------------------------------

Audit:

Claude
Cursor
Kiro
Copilot

Verify:

- sync logic
- mirror logic
- delete propagation
- update propagation

Look for:

- race conditions
- stale copies
- overwrite risks

--------------------------------------------------
PHASE 5 â€” FILESYSTEM MCP SERVER
--------------------------------------------------

Audit:

extension/resources/mcp-servers/filesystem/

Verify:

- MCP compliance
- tool response schema
- error handling

Security review:

- path traversal
- symlinks
- binary files
- large files
- unrestricted paths

Verify:

- 50 MB guard
- binary file detection
- allowed-dirs enforcement
- cache invalidation
- cache TTL behavior

Attempt attacks:

../../../
..\\..\\
symlink escapes
binary payload reads

Report results.

--------------------------------------------------
PHASE 6 â€” CLI MCP SERVER
--------------------------------------------------

Audit:

extension/resources/mcp-servers/cli/

Verify:

- MCP schema compliance
- command execution security

Attempt:

command injection
shell injection
argument confusion

Verify:

- allow-list enforcement
- timeout handling
- Windows command handling
- Linux command handling

--------------------------------------------------
PHASE 7 â€” HOOK SYSTEM
--------------------------------------------------

Audit:

SessionStart
PreToolUse
PostToolUse

Verify:

- registration
- execution flow
- multi-agent compatibility

Review:

- profile-init
- mcp-gate
- CLI loop guard
- dir cache guard
- attribution hooks

--------------------------------------------------
PHASE 8 â€” TELEMETRY
--------------------------------------------------

Audit:

runs.jsonl
mcp-usage.jsonl
cost-attribution.json

Verify:

- telemetry completeness
- duplicate logging
- missing events
- event consistency

Check:

native:run_task
native:run_in_terminal
filesystem MCP events
CLI MCP events

--------------------------------------------------
PHASE 9 â€” KPI ENGINE
--------------------------------------------------

Audit:

mcpUsageLog.ts

Verify:

- scoring math
- waste detection
- repeated reads
- read-after-write
- loops
- scans
- no-op writes

Validate:

GRADE_THRESHOLDS

Check exact boundaries:

44
45
59
60
74
75
89
90

Verify correct grades.

--------------------------------------------------
PHASE 10 â€” COST INTELLIGENCE
--------------------------------------------------

Audit:

skill attribution
cost attribution
ROI calculations
confidence model

Verify:

- dashboard-snapshot.json
- skill-stats.json
- runs.jsonl

Look for:

double counting
missing attribution
incorrect fallback logic

--------------------------------------------------
PHASE 11 â€” WEEKLY REPORTING
--------------------------------------------------

Audit:

weekly email flow

Verify:

- PAT handling
- SMTP configuration
- Secret Storage usage

Test:

auth failure
TLS failure
missing SMTP
missing PAT
GitHub noreply email

--------------------------------------------------
PHASE 12 â€” BRANCH PROFILES
--------------------------------------------------

Audit:

branch-profiles.json

Verify:

- save
- restore
- branch switching
- conflict resolution

--------------------------------------------------
PHASE 13 â€” PROFILE INIT
--------------------------------------------------

Audit:

profile.local.json generation

Verify:

new branch workflow

Check:

request creation
agent suggestions
profile installation
skill application

--------------------------------------------------
PHASE 14 â€” LEARNING SYSTEM
--------------------------------------------------

Audit:

skill-feedback.jsonl
task-skill-proposals.json
system-state.json

Verify:

- adaptation logic
- feedback loop
- proposal generation

--------------------------------------------------
PHASE 15 â€” DOCUMENTATION ACCURACY
--------------------------------------------------

Validate README claims against implementation.

Flag:

- undocumented behavior
- incorrect docs
- stale docs
- broken commands

Verify:

dashboard-snapshot.json references
sync-library command references
v1.0.73 references

--------------------------------------------------
PHASE 16 â€” PERFORMANCE REVIEW
--------------------------------------------------

Review:

startup cost
memory usage
CPU usage
log growth

Look for:

large scans
O(nÂ²) loops
unbounded caches
memory leaks
excessive file reads

--------------------------------------------------
PHASE 17 â€” TEST COVERAGE
--------------------------------------------------

Audit all tests.

Verify coverage of:

- filesystem MCP
- CLI MCP
- security
- weekly reporting
- KPI grading
- branch profiles
- telemetry

Identify missing tests.

--------------------------------------------------
PHASE 18 â€” SECURITY REVIEW
--------------------------------------------------

Perform dedicated security audit.

Review:

filesystem access
CLI execution
secret handling
email system
hooks
JSONL logs

Assign:

LOW
MEDIUM
HIGH
CRITICAL

severity ratings.

--------------------------------------------------
PHASE 19 â€” RELEASE READINESS
--------------------------------------------------

Evaluate:

npm test

Expected:
531 passing

Verify:

node tests/mcp-security.test.js

Expected:
all passing

Determine:

PASS
PASS WITH WARNINGS
FAIL

--------------------------------------------------
PHASE 20 â€” FUTURE ARCHITECTURE
--------------------------------------------------

Evaluate:

Should additional MCP servers exist?

Examples:

Terminal MCP
Build MCP
Deployment MCP

Determine:

- valuable
- unnecessary
- duplicated functionality
- architectural overhead

Provide recommendations.

--------------------------------------------------
REQUIRED OUTPUT FORMAT
--------------------------------------------------

Produce:

1. Executive Summary
2. Architecture Score (0-100)
3. Security Score (0-100)
4. MCP Compliance Score (0-100)
5. Test Coverage Score (0-100)
6. Documentation Score (0-100)
7. Release Readiness Score (0-100)

Then provide:

## Critical Findings
## High Findings
## Medium Findings
## Low Findings

Then provide:

## Quick Wins
## Technical Debt
## Future Enhancements

Then provide:

FINAL VERDICT

One of:

RELEASE READY
RELEASE READY WITH WARNINGS
NOT RELEASE READY

Provide evidence for every finding.

Do not speculate.
Only report findings supported by repository evidence.
