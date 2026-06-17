---
name: "ci-pipeline-debug"
description: "Debug a failing CI pipeline stage (lint/test/validate/build/plan/apply/verify or similar) by locating the exact job definition, reproducing its commands locally, and mapping the failure to a root-cause category. Use when a pipeline/job fails and the user wants to know why or wants it fixed."
applyTo:
  - **/.gitlab-ci.yml
  - **/.gitlab/ci/*.yml
  - **/.github/workflows/*.yml
  - **/.github/workflows/*.yaml
  - **/azure-pipelines.yml
---

# ci-pipeline-debug

# CI Pipeline Debugging

Reproduce CI failures locally instead of guessing from a pipeline name alone.

## 1. Find the job definition

- Identify the failing stage/job name (from the user, a pasted log, or the
  pipeline UI URL).
- The root CI config (e.g. `.gitlab-ci.yml`) usually just lists `stages:` and
  `include:`s — find the actual job in the included per-stage files (e.g.
  `.gitlab/ci/<stage>.yml`).
- Read the job's `script:`, `image:`, `variables:`, and any `before_script:`/
  shared anchors from a `common.yml`-style include.

## 2. Reproduce locally

- Run the job's `script:` commands locally, from the same working directory
  (`cd` to whatever the job's context implies — often a subdirectory like
  `infrastructure/terraform/` or `src/api/`).
- Set any required environment variables the job depends on (check
  `variables:` blocks and CI/CD variable references like `$ARM_CLIENT_ID`,
  `$ARM_TENANT_ID`, etc. — these usually need to be sourced from the user's
  local Azure CLI session or a documented setup script first).
- If the job runs inside a specific Docker image, note version differences
  that might cause local-vs-CI discrepancies (tool versions, OS).

## 3. Map the error to a root cause

Common categories, roughly in order of likelihood:
- **Lint/format**: formatter or linter exits non-zero — usually a quick local fix
  (e.g. `terraform fmt -recursive`, eslint/prettier).
- **Test failure**: a unit/integration test genuinely broke — read the test and
  the code under test, fix the regression. Don't mock around a real failure.
- **Terraform validate/plan/apply error**: hand off to the
  `terraform-plan-review` skill for categorization (real bug vs. permissions gap
  vs. drift).
- **Authorization/RBAC (403, AuthorizationFailed)**: hand off to the
  `azure-rbac-diagnostics` skill.
- **Image build/push failure**: registry auth (check ACR login/managed identity),
  Dockerfile errors, or base image availability.
- **Stale artifact**: a downstream stage (e.g. `apply`) consumes an artifact
  (e.g. `plan.cache`) from an upstream stage and never re-runs it — if the
  upstream stage's output is stale or missing, the fix is in the upstream stage,
  not the one that's failing.

## 4. Check for known/expected blockers first

Before treating a failure as a new bug, check the project's documentation
(CLAUDE.md, README, runbooks) for already-known, expected-to-fail-until-fixed
situations (e.g. "CI SP needs an extra role grant — apply will 403 until an
admin grants it manually"). If the failure matches a documented, external
blocker, say so explicitly rather than proposing a code change to work around it.

## 5. Summarize

Report: which job/stage, the exact command that failed, the root cause category,
whether the fix is a code change (and what), or an external/manual action
(permission grant, secret rotation, infra change) that's outside the repo.
