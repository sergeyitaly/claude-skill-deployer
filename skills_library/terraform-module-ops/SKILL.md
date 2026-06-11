---
name: terraform-module-ops
description: Navigate a Terraform codebase before changing it — build a module-to-resource map, identify the state backend and provider versions, run the safe local fmt/validate workflow, and flag known-drift resources or operations that need explicit user approval (full apply, destroy, state edits). Use before making Terraform changes, to find which file owns a resource, or to check whether an operation is safe to run.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Terraform Module Ops

A navigation and safety layer for an existing Terraform codebase — read this
before editing `.tf` files or running `apply`/`destroy`.

## 1. Locate roots and build a module map

- Find the Terraform root(s) (directories containing `*.tf` + a `backend`
  block) — check `CLAUDE.md`/`README` for the conventional path first
  (commonly `infrastructure/terraform/` or repo root).
- For each `modules/<name>/*.tf` and each root-level `*.tf` file, list the
  resource/data blocks it declares. Build a quick table: module/file →
  resources it owns. This lets you answer "where does X live" without
  re-grepping every time.
- Note the provider versions and required Terraform version (`required_providers`,
  `required_version` in the root `versions.tf`/`backend.tf`).

## 2. Identify the state backend

- Read the `backend` block: backend type (e.g. `azurerm`, `s3`), state
  storage location, and state key/path.
- Note how many resources are in remote state if easily checked
  (`terraform state list | wc -l` requires backend access — only run if the
  user has credentials configured).

## 3. Safe local operations (no credentials needed)

```bash
cd <tf-root>
terraform fmt -check -recursive -diff   # formatting only
terraform init -backend=false -input=false
terraform validate -no-color
```

If init fails with **"Backend initialization required"**, CI/local convention
is usually to temporarily rename `backend.tf`:

```bash
mv backend.tf backend.tf.bak
terraform init -backend=false -input=false
terraform validate -no-color
mv backend.tf.bak backend.tf
```

`terraform plan`/`apply` require provider credentials (e.g. `ARM_*` env
vars) — only run these if the user has them configured, and prefer the
`terraform-plan-review` skill for reviewing the output.

## 4. Check for known drift before planning a change

Look for a project doc describing known out-of-band/drifted resources (e.g.
a "Known drift" section in a `.kiro/skills/*.md`, `docs/`, or `README`).
If such resources exist:
- A full `terraform apply` may try to recreate or destroy them — **do not
  run a full apply** if drift is documented; use `-target=<resource_address>`
  for the specific resource being changed, or resolve drift first via
  `import {}` blocks (see `terraform-plan-review`).

## 5. NEVER do without explicit user approval

- `terraform apply` without `-target`, when known drift exists.
- `terraform destroy` (destroys live infrastructure).
- Editing `.tfstate` directly.
- Reading or printing `*.tfvars` (commonly contains secrets).

## 6. CI mapping

If the project has a CI pipeline, identify the terraform job sequence
(typically `lint:terraform-fmt → terraform:test → terraform:validate →
terraform:plan → terraform:apply (manual gate)`) so you know which stage a
local check corresponds to — see `ci-preflight` for reproducing those stages.
