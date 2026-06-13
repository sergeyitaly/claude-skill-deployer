---
name: "ci-preflight"
description: "Reproduce a CI pipeline's pre-merge stages (lint, test, validate, build) locally before pushing, by mapping each CI job to its exact local-equivalent command and running them in order. Use when asked to \"run CI checks locally\", \"preflight\", \"what would fail in the pipeline\", or before committing/pushing a change."
applyTo:
  - **/.gitlab-ci.yml
  - **/.gitlab/ci/*.yml
  - **/.github/workflows/*.yml
  - **/.github/workflows/*.yaml
  - **/azure-pipelines.yml
---

# ci-preflight

# CI Preflight

Run the no-credentials-required portion of the CI pipeline locally, in the same
order CI runs it, so failures are caught before push instead of after.

## 1. Build the stage map

- Find the CI config (`.gitlab-ci.yml` + `.gitlab/ci/*.yml` includes,
  `.github/workflows/*.yml`, or `azure-pipelines.yml`).
- For each job that does **not** require deploy credentials (no `ARM_*`,
  cloud login, or registry push), extract its `script:`/`run:` steps,
  working directory, and any `image:`/toolchain version.
- Group jobs by stage (lint → test → validate → build → plan/apply) and note
  dependencies (a later stage assumes an earlier one's output exists).

## 2. Map jobs to local commands

Typical mappings — adjust to what the project's CI actually runs:

| Job pattern | Local command |
|---|---|
| `terraform fmt -check` | `cd <tf-root> && terraform fmt -check -recursive -diff` |
| `terraform validate` | `cd <tf-root> && terraform init -backend=false -input=false && terraform validate -no-color` |
| `terraform test` | `cd <tf-root> && terraform init -backend=false -input=false && terraform test -no-color` |
| Node lint/syntax | `npm ci --ignore-scripts && node --check <entrypoint>` |
| Node tests | `npm ci --ignore-scripts && npm test` |
| .NET build | `dotnet restore && dotnet build --configuration Release --no-restore` |
| .NET test | `dotnet test --configuration Release --no-restore` |
| Docker image build | `docker build -t <name>:local <context>` (skip if Docker unavailable — syntax-check the Dockerfile instead) |
| Image scan (Trivy etc.) | `docker run --rm <scanner-image> image --severity CRITICAL --exit-code 1 <name>:local` (skip if Docker unavailable) |

## 3. Known environment gotchas

- **Terraform "Backend initialization required"**: CI usually removes/renames
  `backend.tf` before `init -backend=false`. Reproduce: temporarily
  `Rename-Item backend.tf backend.tf.bak` (or `mv`), run init/validate, then
  restore the file — never leave it renamed.
- **`npm ci --ignore-scripts`**: skips postinstall hooks that may need
  network/creds CI doesn't have either; matches CI behavior.
- **Stale build caches** (e.g. `MSB3492` from MSBuild): drop `-q`/quiet flags
  so the build can overwrite cache files, or clean `bin/`/`obj/` first.
- **Tests that need infra (Redis/DB/queues)**: check whether the test suite is
  *designed* to pass without them (e.g. a `/health` endpoint correctly
  returning 503 when env vars are absent is a pass, not a failure).

## 4. Run and report

- Run stages **in order**, stopping at the first failure unless the user asks
  for a full sweep.
- For each stage report: stage name, command run, pass/fail, and (for
  failures) the first meaningful error line.
- Optionally save the full sequence as a script (e.g. `scripts/preflight.ps1`
  or `scripts/preflight.sh`) so the user can re-run it directly — check
  whether one already exists before creating a new one.

## 5. On failure

Hand off to the `ci-pipeline-debug` skill to categorize the root cause
(lint/format vs. test regression vs. terraform error vs. RBAC), and to
`self-learning` to check whether this exact failure has a known fix recorded
from a previous run.
