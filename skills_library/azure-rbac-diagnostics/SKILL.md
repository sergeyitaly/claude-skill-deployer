---
name: azure-rbac-diagnostics
description: Diagnose Azure RBAC/role-assignment failures (403 AuthorizationFailed, missing identity permissions, Key Vault/ACR/ADX access errors). Distinguishes "Terraform code is correct but the executing identity lacks privilege" from real misconfiguration, and produces the exact az command an admin needs to run. Use when a deployment, terraform apply, or app fails with an authorization/permission error.
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
---

# Azure RBAC Diagnostics

A playbook for "it's a permissions error" situations on Azure. The goal is to
output a precise diagnosis and a remediation command — not just "check your
permissions".

## 1. Identify what failed

From the error message, extract:
- The **operation** that failed (e.g., `Microsoft.Authorization/roleAssignments/write`,
  a Key Vault secret read, an ACR pull/push, an ADX query/ingest).
- The **scope** (resource ID / resource group / subscription) the operation targeted.
- The **principal** that attempted it — may be a user, a CI service principal
  (check `ARM_CLIENT_ID` / pipeline variables), or a managed identity (check the
  resource's `identity` block in Terraform).

## 2. Check current state with az CLI

```bash
# Who am I / what's the active identity?
az account show

# What roles does the principal already have at/above the target scope?
az role assignment list --assignee <principal-id-or-client-id> --all -o table

# What role assignments exist at the target scope (regardless of assignee)?
az role assignment list --scope <resource-id> -o table

# Resolve a service principal's object ID from its client/app ID if needed
az ad sp show --id <client-id> --query id -o tsv
```

## 3. Classify the failure

**a) Executing identity lacks a sufficiently privileged role**
- Most common for Terraform CI service principals trying to create
  `azurerm_role_assignment` resources: this requires `User Access Administrator`
  (or `Owner`) on the target scope, which a plain `Contributor` does not have.
- This is **not a code bug**. The Terraform/code is correct; the gap is purely
  in the Azure RBAC assignments for the *deployer's own identity*.
- Output: the exact missing assignment, expressed as a ready-to-run command for
  whoever has `Owner`/`User Access Administrator`:
  ```bash
  az role assignment create \
    --assignee <ci-sp-object-id> \
    --role "User Access Administrator" \
    --scope /subscriptions/<sub-id>/resourceGroups/<rg-name>
  ```
- Tell the user this step requires a human with elevated privileges (an Azure
  Owner / subscription admin) — it cannot be self-granted by the blocked identity.

**b) Target identity (managed identity / app) lacks data-plane access**
- E.g., Function App's managed identity needs `Key Vault Secrets User`, ADX needs
  a database `Viewer`/`Admin` principal assignment, ACR needs `AcrPull`/`AcrPush`.
- Check whether Terraform already defines this role assignment — if yes, this is
  likely the same "deployer can't create role assignments" issue (case a) blocking
  *this* assignment from ever being created. If no, it's a real missing-config bug:
  add the `azurerm_role_assignment` (or equivalent) resource.

**c) Wrong principal/scope referenced in code**
- The role assignment exists/was created but points at the wrong object ID, or the
  scope is too narrow/broad. This is a real bug — fix the `.tf`/config and re-apply.

## 4. After remediation

- Once an admin grants the missing role, re-run the failed operation
  (`terraform plan`/`apply`, app restart, etc.) — propagation can take a minute or two
  for new role assignments.
- If a resource was created out-of-band while troubleshooting, it may now need an
  `import {}` block — see the `terraform-plan-review` skill.
