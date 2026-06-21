# Claude Skills Manager - End-to-End Skill Efficiency & Adaptation Benchmark
# Version: Benchmark v1.0
# Goal: Verify that skill detection, telemetry, KPI scoring, HACE scoring,
# waste detection, skill confidence adaptation, optimization engine,
# and cross-session learning all work correctly.

====================================================================
BENCHMARK RULES
====================================================================

You are running a controlled benchmark of Claude Skills Manager.

The purpose is NOT to complete work quickly.

The purpose is to verify that:

✓ Skill Gap Detection works
✓ Skill Proposal Engine works
✓ MCP Telemetry Collection works
✓ KPI Scoring works
✓ HACE Scoring works
✓ Waste Detection works
✓ CLI Telemetry works
✓ Skill Confidence updates work
✓ Adaptation logic works
✓ Optimization recommendations work
✓ Cross-session learning signals are generated

You MUST maintain a benchmark verification log throughout execution.

Do not mark a check as PASS unless objective evidence exists.

====================================================================
VERIFICATION LOG FORMAT
====================================================================

After EVERY phase append an in-memory benchmark record using:

{
  "phase": "<phase-name>",
  "status": "PASS|FAIL|PARTIAL",
  "checks": [
    {
      "name": "<check-name>",
      "result": "PASS|FAIL",
      "evidence": "<objective evidence>"
    }
  ]
}

At the end create a Final Benchmark Scorecard.

====================================================================
PHASE 1 - WORKSPACE DISCOVERY
====================================================================

Analyze the repository.

Identify:

- Languages
- Frameworks
- Cloud providers
- Terraform usage
- Kubernetes usage
- Helm usage
- CI/CD tools
- Security-related files

Determine:

1. Relevant skills
2. Irrelevant skills
3. Missing skills
4. Recommended skills

Checks:

[ ] Repository analyzed
[ ] Technologies detected
[ ] Relevant skills identified
[ ] Irrelevant skills identified
[ ] Missing skills identified
[ ] Proposed skills generated
[ ] Skill-gap detector produced useful output

Evidence Required:

- file names
- directories inspected
- technology markers
- skill names

PASS CRITERIA:

Repository analysis contains evidence-based findings.

Log results.

====================================================================
PHASE 2 - EFFICIENT TASK EXECUTION
====================================================================

Perform a realistic repository task.

Workflow:

1. Select a configuration or infrastructure file.
2. Read it.
3. Explain its purpose.
4. Identify one improvement.
5. Apply improvement.
6. Validate consistency with related files.

Efficiency Requirements:

- Avoid rereading unchanged files.
- Avoid duplicate scans.
- Reuse cached context.
- Avoid unnecessary tool calls.

Collect:

- number of file reads
- number of file writes
- number of scans

Checks:

[ ] File read
[ ] File analyzed
[ ] Improvement identified
[ ] Modification completed
[ ] Validation completed
[ ] Duplicate reads avoided
[ ] Duplicate scans avoided

PASS CRITERIA:

Duplicate reads <= 1
Duplicate scans <= 1

Log evidence.

====================================================================
PHASE 3 - INFRASTRUCTURE DISCOVERY
====================================================================

Search repository for:

- Terraform
- Kubernetes
- Helm
- Docker
- Azure
- AWS
- GCP
- GitHub Actions
- ArgoCD
- Kubernetes Operators

Produce:

- architecture summary
- infrastructure inventory

Checks:

[ ] Terraform detected
[ ] Kubernetes detected
[ ] Cloud provider identified
[ ] CI/CD identified
[ ] Architecture summary generated

Evidence:

- actual file paths
- actual technologies

PASS CRITERIA:

Architecture summary references detected files.

Log results.

====================================================================
PHASE 4 - CLI MCP BENCHMARK
====================================================================

If CLI MCP is available:

Execute only:

git status
git branch
git log --oneline -5

Do NOT repeat commands.

Collect:

- command
- exit code
- duration

Checks:

[ ] git status executed
[ ] git branch executed
[ ] git log executed
[ ] No duplicate executions
[ ] Commands succeeded

PASS CRITERIA:

All exit codes = 0

Log results.

====================================================================
PHASE 5 - MCP TELEMETRY VALIDATION
====================================================================

Verify telemetry generation.

Checks:

[ ] MCP telemetry generated
[ ] File operations recorded
[ ] CLI operations recorded
[ ] Session telemetry available
[ ] KPI computation inputs available

Evidence:

- telemetry entries
- operation counts

PASS CRITERIA:

Telemetry exists for actions completed so far.

Log evidence.

====================================================================
PHASE 6 - INTENTIONAL INEFFICIENCY TEST
====================================================================

Now intentionally perform inefficient actions.

Required:

1. Read same file 3 times.
2. Scan same directory 3 times.
3. Reopen an already analyzed file.
4. Read file immediately after write.
5. Perform redundant investigation.

Goal:

Trigger waste detectors.

Checks:

[ ] Repeated-read detector triggered
[ ] Excessive-scan detector triggered
[ ] Read-after-write detector triggered
[ ] Waste identified
[ ] KPI impact observed

Collect:

- KPI before
- KPI after

PASS CRITERIA:

At least one waste pattern detected.

Log evidence.

====================================================================
PHASE 7 - SKILL CONFIDENCE ANALYSIS
====================================================================

Analyze all skills used during benchmark.

Determine:

- Frequently useful skills
- Rarely useful skills
- Missing skills
- Overlapping skills
- Candidate archive skills

Checks:

[ ] Skill confidence evaluated
[ ] High-confidence skills identified
[ ] Low-confidence skills identified
[ ] Missing skills identified
[ ] Archive candidates identified

Evidence:

- skill names
- confidence values
- usage counts

PASS CRITERIA:

Recommendations are telemetry-based.

Log results.

====================================================================
PHASE 8 - TASK-SKILL ADAPTATION REVIEW
====================================================================

Using benchmark observations:

Recommend:

1. Skills to enable
2. Skills to disable
3. Skills to archive
4. Skills to create
5. Skills to merge

Checks:

[ ] Enable recommendations generated
[ ] Disable recommendations generated
[ ] Archive recommendations generated
[ ] Creation opportunities identified
[ ] Adaptation reasoning provided

Evidence:

- supporting telemetry
- usage statistics

PASS CRITERIA:

All recommendations reference benchmark data.

Log results.

====================================================================
PHASE 9 - HACE VALIDATION
====================================================================

Calculate or estimate:

Prompt Clarity
Task Velocity
Accuracy Rate
CLI Efficiency

Then compute:

HACE (Human-AI Collaboration Efficiency Score)

Provide:

- metric values
- score
- grade

Checks:

[ ] Prompt Clarity evaluated
[ ] Task Velocity evaluated
[ ] Accuracy evaluated
[ ] CLI Efficiency evaluated
[ ] HACE calculated

PASS CRITERIA:

Formula inputs clearly explained.

Log results.

====================================================================
PHASE 10 - LEARNING SYSTEM VALIDATION
====================================================================

Verify that the session generated learning opportunities.

Determine whether:

- confidence changed
- optimization suggestions appeared
- new adaptation signals exist
- future sessions can improve

Checks:

[ ] Learning signals generated
[ ] Confidence changes detected
[ ] Optimization opportunities detected
[ ] Future guidance created

Evidence:

- before values
- after values
- generated suggestions

PASS CRITERIA:

At least one measurable adaptation signal exists.

Log results.

====================================================================
PHASE 11 - CROSS-SESSION INTELLIGENCE REVIEW
====================================================================

Determine what should be remembered for future sessions.

Identify:

- frequently re-read files
- frequently used skills
- reusable discoveries
- useful cache candidates

Checks:

[ ] Cache candidates identified
[ ] High-value files identified
[ ] Reusable knowledge identified
[ ] Future optimization opportunities identified

PASS CRITERIA:

Concrete future-session recommendations exist.

Log results.

====================================================================
FINAL SCORECARD
====================================================================

Generate:

{
  "benchmarkId": "<timestamp>",
  "checksTotal": <number>,
  "checksPassed": <number>,
  "checksFailed": <number>,
  "passRate": "<percentage>",
  "skillGapDetector": true|false,
  "taskProposalsGenerated": true|false,
  "mcpTelemetryCollected": true|false,
  "cliTelemetryCollected": true|false,
  "wasteDetected": true|false,
  "kpiCalculated": true|false,
  "haceCalculated": true|false,
  "skillConfidenceChanged": true|false,
  "adaptationTriggered": true|false,
  "optimizationGenerated": true|false,
  "crossSessionLearningGenerated": true|false,
  "kpiBefore": <number>,
  "kpiAfter": <number>,
  "haceScore": <number>,
  "finalStatus": "PASS|FAIL"
}

====================================================================
FINAL HUMAN READABLE REPORT
====================================================================

Provide sections:

1. Skills Used
2. Skills Proposed
3. Skills Missing
4. Skills Archived
5. Skills Recommended
6. Skill Confidence Changes
7. MCP Telemetry Summary
8. CLI Telemetry Summary
9. Waste Detection Results
10. KPI Before vs After
11. HACE Analysis
12. Estimated Token Savings
13. Cross-Session Learnings
14. Optimization Opportunities
15. Adaptation Results

Finally answer:

"Did the system actually learn something useful?"

Provide evidence.

PASS VERDICT:

The benchmark demonstrates measurable telemetry collection,
skill evaluation, confidence updates, adaptation recommendations,
waste detection, and learning signals.

FAIL VERDICT:

Metrics were generated but no measurable adaptation or learning occurred.