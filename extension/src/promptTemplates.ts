/**
 * Prompt Template Library (Phase 5)
 *
 * 10 domain templates — each enforces the 6 quality dimensions:
 * objective · environment · current behaviour · expected behaviour · evidence · success criteria.
 *
 * Templates are surfaced in the dashboard as copyable scaffolds.
 * Users fill in [BRACKETS] before submitting.
 */

export interface PromptTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  body: string;
  /** Estimated quality score this template achieves when filled correctly */
  baseScore: number;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "k8s-troubleshoot",
    name: "Kubernetes Troubleshooting",
    category: "Infrastructure",
    description: "Pod failures, CrashLoopBackOff, networking, RBAC, resource limits",
    icon: "⚙",
    baseScore: 85,
    body: `## Objective
Fix [DESCRIBE THE ISSUE — e.g. "CrashLoopBackOff on the api-server pod"]

## Environment
- Cluster: [cluster name / provider: EKS / GKE / AKS / k3s]
- Namespace: [namespace]
- Kubernetes version: [kubectl version --short]
- Affected workload: [deployment / statefulset / daemonset name]

## Current behaviour
[Describe what is happening]

\`\`\`
[Paste: kubectl describe pod <name> -n <ns>]
[Paste: kubectl logs <pod> -n <ns> --previous]
\`\`\`

## Expected behaviour
[What should happen when fixed]

## What I already tried
- [Step 1]
- [Step 2]

## Success criteria
- [ ] Pod reaches Running state
- [ ] No error in logs for 2 minutes
- [ ] Readiness probe passes

## Request
1. Root cause analysis
2. Exact fix commands
3. Validation commands
4. Rollback plan`,
  },

  {
    id: "devops-investigation",
    name: "DevOps Investigation",
    category: "DevOps",
    description: "General incident, deployment failure, pipeline regression",
    icon: "🔍",
    baseScore: 82,
    body: `## Objective
Investigate [DESCRIBE THE SYMPTOM — e.g. "deployment to staging failed at the DB migration step"]

## Environment
- System: [service / pipeline / environment name]
- Platform: [AWS / Azure / GCP / on-prem]
- Change context: [PR / commit / deploy that triggered this]

## Timeline
- [TIME] — [what happened]
- [TIME] — [next event]

## Evidence
\`\`\`
[Paste: error output / deployment logs / alerts]
\`\`\`

## Impact
- [Who / what is affected]
- [Severity: critical / high / medium]

## Expected state
[Normal operating behaviour]

## Success criteria
- [ ] Root cause identified with evidence
- [ ] Fix applied and validated
- [ ] Monitoring confirms recovery

## Request
1. Root cause
2. Immediate mitigation
3. Permanent fix
4. Post-mortem prevention steps`,
  },

  {
    id: "aws-incident",
    name: "AWS Incident Response",
    category: "Cloud",
    description: "ECS, Lambda, RDS, S3, IAM, CloudWatch alerts",
    icon: "☁",
    baseScore: 83,
    body: `## Objective
Resolve [AWS SERVICE] incident: [DESCRIBE THE ISSUE]

## Environment
- Region: [us-east-1 / eu-west-1 / ...]
- Account ID: [if relevant]
- Affected resources: [ARN / resource name]
- AWS service(s): [ECS / Lambda / RDS / S3 / IAM / ...]

## Evidence
\`\`\`
[Paste: CloudWatch logs / error response / AWS CLI output]
\`\`\`

## IAM / Permissions context
- Role in use: [role ARN or name]
- Permission error (if any): [exact message]

## Current behaviour
[What is failing or behaving incorrectly]

## Expected behaviour
[What should happen]

## Success criteria
- [ ] Service responds normally
- [ ] No errors in CloudWatch for 5 minutes
- [ ] Health check passes

## Request
1. Diagnosis with evidence
2. AWS CLI fix commands (exact)
3. IAM policy changes if needed
4. Monitoring / alerting recommendation`,
  },

  {
    id: "azure-troubleshoot",
    name: "Azure Troubleshooting",
    category: "Cloud",
    description: "AKS, App Service, Azure Functions, RBAC, KeyVault, networking",
    icon: "🔷",
    baseScore: 83,
    body: `## Objective
Fix [AZURE RESOURCE / SERVICE] issue: [DESCRIBE THE PROBLEM]

## Environment
- Subscription: [name or ID]
- Resource Group: [rg name]
- Resource type: [AKS / App Service / Function / ...]
- Region: [eastus / westeurope / ...]

## Evidence
\`\`\`
[Paste: az cli output / portal error / Application Insights log]
\`\`\`

## RBAC context
- Principal in use: [managed identity / service principal / user]
- Role assignments: [what roles exist]
- Error: [exact access denied message if applicable]

## Current behaviour
[What fails and how]

## Expected behaviour
[What should work]

## Success criteria
- [ ] Operation completes without error
- [ ] Metrics/logs show normal state
- [ ] RBAC audit passes

## Request
1. Root cause (with az CLI diagnostic commands)
2. Exact fix (Bicep / ARM / az CLI)
3. RBAC changes if needed
4. Rollback plan`,
  },

  {
    id: "github-actions-failure",
    name: "GitHub Actions Failure",
    category: "CI/CD",
    description: "Workflow failure, failed step, permissions, caching, environment",
    icon: "⚡",
    baseScore: 84,
    body: `## Objective
Fix failing GitHub Actions workflow: [WORKFLOW NAME / step that fails]

## Environment
- Repo: [owner/repo]
- Workflow file: [.github/workflows/name.yml]
- Failing step: [exact step name]
- Runner: [ubuntu-latest / windows-latest / self-hosted]

## Workflow context
\`\`\`yaml
[Paste the failing job/step definition]
\`\`\`

## Failure output
\`\`\`
[Paste: exact error from Actions log]
\`\`\`

## What changed recently
- [PR / commit / dependency update that may have caused this]

## Expected behaviour
[Workflow should complete and produce ...]

## Success criteria
- [ ] Workflow passes green on next push
- [ ] No regression in other jobs
- [ ] Cache/artefacts behave correctly

## Request
1. Root cause of failure
2. Fixed workflow YAML (diff or full step)
3. How to validate before merging`,
  },

  {
    id: "terraform-deployment",
    name: "Terraform Deployment",
    category: "IaC",
    description: "Plan failures, state issues, provider errors, module problems",
    icon: "🏗",
    baseScore: 85,
    body: `## Objective
Fix Terraform issue: [DESCRIBE — e.g. "plan fails with provider version conflict"]

## Environment
- Provider: [aws / azurerm / google / kubernetes]
- Terraform version: [terraform version]
- Workspace: [workspace name]
- State backend: [S3 / Azure Blob / Terraform Cloud / local]

## Error output
\`\`\`
[Paste: terraform plan / apply / init error]
\`\`\`

## Relevant resource block
\`\`\`hcl
[Paste the resource or module that is failing]
\`\`\`

## Current state
[What exists already / what the plan is trying to change]

## Expected outcome
[What infrastructure should exist after apply]

## Constraints
- Must not destroy: [list critical resources]
- Must not change: [networking / IAM / existing data]

## Success criteria
- [ ] terraform plan exits 0
- [ ] apply completes with no errors
- [ ] Resources exist in console/portal

## Request
1. Root cause
2. Fixed HCL
3. Safe import / state manipulation if needed
4. Validation commands`,
  },

  {
    id: "vscode-extension-dev",
    name: "VS Code Extension Development",
    category: "Extension",
    description: "Extension host errors, API usage, webview, commands, publishing",
    icon: "🧩",
    baseScore: 82,
    body: `## Objective
[DESCRIBE: e.g. "Add a command that reloads skill proposals without restarting the extension"]

## Environment
- VS Code version: [Help > About]
- Extension manifest engine: [package.json engines.vscode value]
- Node / npm version: [node -v / npm -v]
- Running in: [Extension Development Host / production install]

## Current behaviour
[What happens now, or what error appears]

\`\`\`
[Paste: Extension Host log / console error from Developer Tools]
\`\`\`

## Expected behaviour
[What should happen]

## Relevant existing code
\`\`\`typescript
[Paste: the function / activation event / contribution point involved]
\`\`\`

## Constraints
- Must not break: [existing commands / webview state / other features]
- Must work on: [VS Code 1.8x+ / Windows + Mac + Linux]

## Success criteria
- [ ] Command appears in Command Palette
- [ ] No Extension Host errors in Output panel
- [ ] Behaviour matches expected on all platforms

## Request
1. Implementation with exact API usage
2. package.json contribution point if needed
3. How to test in Extension Development Host`,
  },

  {
    id: "architecture-review",
    name: "Architecture Review",
    category: "Design",
    description: "System design review, trade-off analysis, scalability assessment",
    icon: "📐",
    baseScore: 78,
    body: `## Objective
Review the architecture for: [COMPONENT / SYSTEM / FEATURE]

## Context
- System: [what this component does in the broader system]
- Scale: [current load / expected growth]
- Tech stack: [languages / frameworks / infra]
- Team size: [how many devs maintain this]

## Current design
[Describe or paste diagram / key decisions]

\`\`\`
[Optional: paste relevant config, schema, or infrastructure code]
\`\`\`

## Concerns to address
- [Performance concern]
- [Reliability concern]
- [Security concern]
- [Operational concern]

## Constraints
- Budget: [cost limits]
- Timeline: [when changes must be live]
- Must not change: [locked dependencies / contracts]

## Success criteria
- [ ] Design handles [X] requests/sec with <[Y]ms P95
- [ ] Single point of failure eliminated
- [ ] Runbook exists for failure modes

## Request
1. Identify top 3 risks in current design
2. Recommended changes (with trade-offs)
3. Migration path from current state`,
  },

  {
    id: "feature-implementation",
    name: "Feature Implementation",
    category: "Development",
    description: "New feature, API endpoint, UI component, background job",
    icon: "✨",
    baseScore: 80,
    body: `## Objective
Implement: [FEATURE NAME — one sentence description]

## Context
- Repo: [repo / service / module this belongs to]
- Related files: [key files to read before starting]
- Existing patterns: [how similar features are implemented in this codebase]

## Acceptance criteria
- [ ] [User-visible behaviour 1]
- [ ] [User-visible behaviour 2]
- [ ] [Edge case handled]
- [ ] [Tests pass]

## Constraints
- Must not change: [existing API contracts / database schema / public interface]
- Must follow: [existing code style / patterns in this file]
- Performance: [latency / memory / throughput target]

## Out of scope
- [What NOT to implement in this PR]

## Definition of done
- [ ] Implementation complete
- [ ] Unit tests written
- [ ] No TypeScript errors
- [ ] No regressions in existing tests

## Request
1. Implementation plan (files to touch + changes)
2. Code with tests
3. Any migration or config needed`,
  },

  {
    id: "root-cause-analysis",
    name: "Root Cause Analysis",
    category: "Investigation",
    description: "Systematic 5-why investigation for recurring issues or incidents",
    icon: "🔬",
    baseScore: 86,
    body: `## Objective
Perform root cause analysis for: [INCIDENT / BUG / RECURRING FAILURE]

## Incident summary
- When: [date and time]
- Duration: [how long it lasted]
- Impact: [who/what was affected]
- Detected by: [alert / user report / monitoring]

## Timeline of events
| Time | Event |
|------|-------|
| [T+0] | [first symptom] |
| [T+Xm] | [escalation / detection] |
| [T+Ym] | [mitigation applied] |
| [T+Zm] | [recovery confirmed] |

## Evidence
\`\`\`
[Paste: logs / metrics / error messages that describe the failure]
\`\`\`

## Contributing factors
- [System factor]
- [Process factor]
- [Human factor]

## What we tried during the incident
- [Action 1] → [result]
- [Action 2] → [result]

## Success criteria for RCA
- [ ] True root cause identified (not just proximate cause)
- [ ] 5-why chain documented
- [ ] Preventive actions are specific and assignable

## Request
1. 5-why root cause chain
2. Contributing factors (technical + process)
3. Preventive action items (ranked by impact)
4. Detection improvement recommendations`,
  },
];

// ---------------------------------------------------------------------------
// Lookup and formatting
// ---------------------------------------------------------------------------

export function getTemplate(id: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find(t => t.id === id);
}

export function getTemplatesByCategory(): Map<string, PromptTemplate[]> {
  const map = new Map<string, PromptTemplate[]>();
  for (const t of PROMPT_TEMPLATES) {
    const arr = map.get(t.category) ?? [];
    arr.push(t);
    map.set(t.category, arr);
  }
  return map;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTemplateLibraryHtml(): string {
  const byCategory = getTemplatesByCategory();

  const sections = [...byCategory.entries()].map(([cat, templates]) => {
    const cards = templates.map(t => `
<div class="skill-row" style="margin-bottom:4px">
  <div class="skill-head">
    <span style="font-size:14px;margin-right:4px">${t.icon}</span>
    <b>${esc(t.name)}</b>
    <span class="conf-high" style="font-size:10px">~${t.baseScore}/100</span>
  </div>
  <div class="hint">${esc(t.description)}</div>
  <details style="margin-top:4px">
    <summary style="cursor:pointer;font-size:11px;color:var(--vscode-textLink-foreground,#4a9eff)">Show template</summary>
    <pre style="font-size:10px;white-space:pre-wrap;word-break:break-word;background:var(--vscode-textBlockQuote-background);padding:8px;border-radius:3px;margin-top:4px;overflow:auto;max-height:280px">${esc(t.body)}</pre>
  </details>
</div>`).join("");

    return `<div style="margin-bottom:10px">
  <p class="note" style="font-weight:600;margin-bottom:4px">${esc(cat)}</p>
  ${cards}
</div>`;
  }).join("");

  return `<div class="panel" style="margin-top:6px">
  <h2 style="margin-top:0">Prompt Template Library</h2>
  <p class="note" style="margin-top:0">Fill in [BRACKETS] before submitting. Each template targets a prompt quality score ≥80/100.</p>
  ${sections}
</div>`;
}
