---
name: terraform-plan-review
description: Run terraform fmt/validate/plan and review the output — categorize changes, flag destroys, and triage failures into "real bug" vs "permissions gap" vs "state drift fixable via import block". Use when asked to check Terraform state, review/run a plan, or debug a validate/plan/apply failure.
user-invocable: true
deprecated: true
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

# Terraform Plan Review

A diagnostic playbook for Terraform (azurerm or otherwise, TF >= 1.5). Goal: turn a
`plan`/`apply` failure or a routine plan into a short, actionable summary —
not a wall of raw output.

## 1. Locate the root and run the basics

- Find the Terraform root (look for `*.tf` + `backend` config — check a project doc
  like `CLAUDE.md`/`README` first for the conventional path, e.g. `infrastructure/terraform/`).
- Run, in order, from that directory:
  ```
  terraform fmt -recursive -check
  terraform validate
  terraform plan -var-file=terraform.tfvars -out=plan.out
  ```
- If `fmt -check` reports files, run `terraform fmt -recursive` (no `-check`) to fix them
  and note which files changed.

## 2. Summarize the plan

Don't paste the raw plan. Extract and report:
- Counts: `N to add, N to change, N to destroy`.
- **Any destroy or replace (`-/+`)** — call these out explicitly with the resource address
  and the attribute that's forcing replacement (`# forces replacement` lines). These are
  the highest-risk changes and deserve a sentence on *why* before applying.
- Resources changing for reasons unrelated to the user's actual edit (signs of drift).

## 3. Triage failures into categories

When `validate`/`plan`/`apply` errors, classify each error before proposing a fix:

**a) Permissions gap (not a code bug)**
- Symptom: `AuthorizationFailed` / 403 on `azurerm_role_assignment` or similar
  identity/RBAC resources.
- Meaning: the identity running Terraform lacks a sufficiently privileged role
  (commonly `User Access Administrator` or `Owner`) on the target scope to *create*
  role assignments. The Terraform code is usually correct.
- Action: report which assignment(s) are blocked, the scope, and the role needed.
  Recommend the user/admin grant that role to the executing identity — do not
  "fix" this by removing the role assignment resource or adding
  `skip_service_principal_aad_check` unless the project explicitly calls for it.

**b) State drift**
- Symptom: plan wants to create a resource that already exists in Azure (or destroy
  one that's already gone), or shows unexpected changes to attributes nobody edited.
- Action: prefer **`import {}` blocks** (native expressions, TF >= 1.7) over the
  `terraform import` CLI:
  ```hcl
  import {
    to = azurerm_resource_group.example
    id = "/subscriptions/.../resourceGroups/example"
  }
  ```
  Place these near the resource definition or in a dedicated `imports.tf`, run
  `terraform plan` again to confirm the diff disappears, and remove the import
  block once applied (or leave it — it's a no-op after import).

**c) Real configuration bug**
- Symptom: validate error (bad reference, type mismatch, missing required arg), or
  a plan diff that doesn't match either category above.
- Action: fix the `.tf` source directly. Re-run `validate`/`plan` to confirm.

## 4. Before wrapping up

- Re-run `terraform plan` after any fix and confirm the diff is now either empty or
  matches the user's intended change exactly.
- If a `plan.out`/`plan.cache` artifact is consumed by a separate `apply` CI stage,
  don't assume your local plan is what apply will use — check whether apply re-plans
  or downloads a cached artifact.
- Never run `terraform apply` without explicit user confirmation — plans are
  reversible to review, applies often aren't.
