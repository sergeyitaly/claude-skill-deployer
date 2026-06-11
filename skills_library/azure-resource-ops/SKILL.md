---
name: azure-resource-ops
description: Investigate and operate on a project's live Azure resources — build/maintain a resource quick-reference, run common diagnostic commands (health checks, resource state, identity/role checks via az rest, Key Vault secret names, Log Analytics/ADX queries), and record operational quirks so they don't need rediscovering. Use when asked about live resource state, to debug a deployed app, or before running az commands against a project's resources.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Azure Resource Ops

A working playbook for live Azure resources tied to a project — build it up
once, then reuse it instead of re-discovering names and quirks every session.

## 1. Find or build the resource quick-reference

- Look for an existing reference doc first (e.g. `.kiro/skills/azure-ops.md`,
  `docs/azure-resources.md`, or a "Resources" section in the README/CLAUDE.md).
- If none exists, derive one from Terraform (`terraform output`,
  `grep -r "resource \"azurerm_" infrastructure/`) or directly from Azure:
  ```bash
  az group list -o table
  az resource list -g <resource-group> -o table
  ```
- Record: resource name, type, resource group, region, and any non-default
  config relevant to operations (SKU, networking mode, identity). Save this
  to a project doc so future sessions don't re-query for static facts.

## 2. Common diagnostic commands

```bash
# Identity / login
az account show

# HTTP health check (for an exposed API/app)
curl -sf <api-base-url>/health | jq .

# Container App: active revision + env vars
az containerapp show -n <app> -g <rg> \
  --query '{revision:properties.latestRevisionName, envs:properties.template.containers[0].env}'

# Function App state
az functionapp show -n <func-app> -g <rg> --query state

# Role/alert/property fields the CLI shows as null — use REST instead
az rest --method GET \
  --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/<provider>/<type>/<name>?api-version=<api-version>" \
  --query properties.<field>

# Kusto/ADX query
az kusto query --cluster-name <cluster> --database-name <db> \
  --resource-group <rg> --csl "<table> | take 5"

# Key Vault secret NAMES only — never print values
az keyvault secret list --vault-name <kv-name> --query "[].name"
```

## 3. Record operational quirks as you find them

When something behaves unexpectedly but isn't a bug to fix (CLI display
bugs, private-DNS-only resolution, intentional region/naming mismatches from
imported resources, etc.), append it to the project's quirks doc with a short
explanation — so the next session doesn't re-debug the same thing.

## 4. Security rules

- Never print secret **values** — only names/existence (`az keyvault secret
  list --query "[].name"`, never `secret show`).
- Prefer managed-identity-based auth checks over assuming connection strings
  are used.
- Treat subscription IDs, tenant IDs, and resource names from `.env`/tfvars
  as sensitive context — don't echo them into shared output unnecessarily.

## 5. Hand-offs

- `403`/`AuthorizationFailed` errors → `azure-rbac-diagnostics`.
- Terraform-side issues (drift, plan/apply errors) → `terraform-module-ops`
  / `terraform-plan-review`.
- Record the outcome of any non-trivial diagnostic session via
  `self-learning` so repeated issues get faster the second time.
