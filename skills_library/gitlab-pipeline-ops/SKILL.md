---
name: gitlab-pipeline-ops
description: Work with a GitLab CI/CD project structured like a typical multi-stage pipeline (root .gitlab-ci.yml with stages/workflow/include, per-area job files under .gitlab/ci/*.yml, shared templates and rules in common.yml, manual gates on main for plan/apply/deploy). Use when reading, editing, or debugging .gitlab-ci.yml / .gitlab/ci/*.yml, inspecting pipeline/job status with glab, or working with GitLab CI/CD variables.
user-invocable: true
allowed-tools:
  - mcp__claude-skills-cli__run_command
  - mcp__claude-skills-cli__list_available_clis
  - mcp__filesystem__read_file
  - mcp__filesystem__write_file
  - mcp__filesystem__list_directory
  - mcp__filesystem__search_files
  - Glob
  - Grep
  - Edit
---

# GitLab Pipeline Ops

A structure/navigation playbook for GitLab CI/CD projects split across
`.gitlab/ci/*.yml` includes (the layout used by the Team3 fleet-telemetry
pipeline), plus how to inspect live pipeline/job state with `glab`.

## 1. Read the structure before editing anything

- Root `.gitlab-ci.yml` usually only declares:
  - `stages:` — the ordered list of pipeline stages.
  - `workflow: rules:` — when a pipeline runs at all (e.g. MR events,
    branch pushes, manual `web` triggers).
  - `include: - local: .gitlab/ci/<area>.yml` — one file per concern
    (lint, app tests, image build/scan, terraform, deploy).
- `.gitlab/ci/common.yml` (or similar) holds **shared variables** and
  **hidden job templates** (`.foo_ci`, `.rules_*`) that other files
  `extends:`. Read this first — it explains image choices, caching keys,
  and the rule sets every job reuses.
- A `.gitlab/ci/README.md`, if present, documents the file→stage→job
  mapping and required CI/CD variables — check it before grepping.

## 2. Common rule-template patterns

These hidden jobs (`.rules_*`) typically gate when a job runs:

| Pattern | Meaning |
|---|---|
| `.rules_mr_and_branch` | Runs on MRs and branch pushes — normal lint/test. |
| `.rules_main_only` | Runs only on `main` (no manual gate). |
| `.rules_main_manual` | Runs on `main`, but `when: manual` — a human must click "play". |
| `.rules_*_terraform` / similar | Only runs when cloud credentials (e.g. `ARM_CLIENT_ID`) are present, so plan/apply jobs don't fail outright in forks/MRs without secrets. |
| `.rules_deploy` | `when: manual`, often with an `environment:` block for deploy tracking. |

When adding a new job, find the closest existing job with the rule
behavior you want and copy its `extends:`/`rules:` rather than
hand-writing new `if:` conditions.

## 3. Pipeline flow and manual gates

Map the `stages:` list to a flow diagram (e.g.
`lint → test → validate → build → plan → apply (manual, main only)`).
Jobs with `when: manual` (often `*:apply`, `deploy:*`) are intentional
human checkpoints — don't try to make these run automatically unless
asked, and don't assume a pipeline "failed" because a manual job is
sitting unstarted.

## 4. Terraform-specific jobs

`terraform:plan`/`terraform:apply` typically:
- Require `ARM_CLIENT_ID`/`ARM_CLIENT_SECRET`/`ARM_SUBSCRIPTION_ID`/`ARM_TENANT_ID`
  (validated with `: "${VAR:?msg}"` guards at the top of the script).
- Fall back to `-backend=false` (after removing `backend.tf`) when
  `TF_STATE_*` variables aren't set, so plan still runs for syntax/drift
  checking without remote state.
- Pass artifacts (`plan.cache`, `plan.txt`) from `plan` to `apply` —
  `apply` does **not** re-plan, it applies the cached plan.

For local reproduction of these stages, see `ci-preflight`; for
categorizing a failure, see `ci-pipeline-debug`; for the Terraform side
specifically, see `terraform-module-ops` / `terraform-plan-review`.

## 5. Inspecting live pipelines with `glab`

If the `glab` CLI is available and authenticated:

```bash
glab ci status                 # latest pipeline for current branch
glab ci view                   # interactive pipeline view
glab ci trace <job-name>        # tail logs for a specific job
glab ci list                   # recent pipelines
```

If `glab` isn't available, use the GitLab web UI URL pattern
`<repo-url>/-/pipelines` — ask the user for the pipeline/job URL or ID
rather than guessing one.

## 6. CI/CD variables

- Variables are set in GitLab project/group settings (Settings → CI/CD →
  Variables) — never hold real secret values in the repo.
- A project may ship a generator script (e.g.
  `scripts/generate-gitlab-cicd-variables.ps1`) that creates a service
  principal and optionally pushes variables via the GitLab API
  (`-PushToGitLab`). A `*.template.json` alongside it documents the
  expected variable names without secrets — use that as the source of
  truth for "what variables does this pipeline need".
- When a job fails because a variable is missing/empty, check whether
  it's masked/protected (protected variables are only available on
  protected branches/tags — a pipeline on a feature branch may
  legitimately not have access to them).

## 7. Hand-offs

- Reproducing stages locally → `ci-preflight`.
- Categorizing a failure (lint/test/terraform/RBAC/stale-artifact) →
  `ci-pipeline-debug`.
- Terraform plan/apply output → `terraform-plan-review`.
- Azure-side resource/RBAC issues surfaced by `apply`/`deploy` jobs →
  `azure-resource-ops` / `azure-rbac-diagnostics`.
