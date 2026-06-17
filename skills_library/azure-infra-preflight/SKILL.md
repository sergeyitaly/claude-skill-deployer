---
name: azure-infra-preflight
description: Pre-flight checklist before any Azure Terraform deploy — verify az login, detect SSH key type (Azure only accepts RSA), check whether the target resource group already exists and list resources to generate import blocks, validate Terraform version, and write subscription context. Use before terraform plan/apply on a new or potentially pre-existing Azure environment, or when setting up Azure IaC files from scratch.
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

# Azure Infra Preflight

A pre-deploy checklist that prevents the most common first-run failures in
Azure Terraform workflows. Run this before writing a `terraform plan`.

## 1. Verify toolchain

```
mcp__claude-skills-cli__list_available_clis
```

Confirm `az` and `terraform` are both available. If either is missing, stop
and tell the user which tool to install.

Check Terraform version:
```
mcp__claude-skills-cli__run_command { cli: "terraform", args: ["version"] }
```
Gate on `>= 1.6` (required for `import {}` block syntax support).

## 2. Azure login + record subscription

```
mcp__claude-skills-cli__run_command { cli: "az", args: ["account", "show", "--output", "json"] }
```

If exitCode ≠ 0: stop. Tell the user to run `az login` manually (the MCP
server cannot open a browser).

If exitCode = 0: write the JSON to `<workspace>/.claude/<project>/subscription.json`
via `mcp__filesystem__write_file` so subsequent sessions skip this step.

## 3. SSH key type check (Azure rejects ed25519)

Before writing `terraform.tfvars` with an SSH public key:

1. Check `~/.ssh/id_rsa.pub` first (preferred for Azure).
2. If only `~/.ssh/id_ed25519.pub` exists, do **not** use it — Azure
   `azurerm_linux_virtual_machine` rejects ed25519 at `terraform plan` time
   with a hard error, even though init succeeds.
3. If no RSA key exists, generate one:
   ```
   mcp__claude-skills-cli__run_command {
     cli: "ssh-keygen",  // only if on allow-list, otherwise use Bash
     args: ["-t", "rsa", "-b", "4096", "-f", "<workspace>/.claude/<project>/deploy-key", "-N", ""]
   }
   ```
   On Windows, use Git Bash via Bash tool if `ssh-keygen` is not on the CLI
   allow-list:
   ```bash
   ssh-keygen -t rsa -b 4096 -f "<keydir>/deploy-key" -N "" && cat "<keydir>/deploy-key.pub"
   ```

## 4. Check whether resources already exist (import-before-apply)

```
mcp__claude-skills-cli__run_command {
  cli: "az",
  args: ["group", "exists", "--name", "<resource-group>"]
}
```

- **stdout = `false`**: resources are new — proceed with `terraform plan` normally.
- **stdout = `true`**: resources already exist. List them:
  ```
  mcp__claude-skills-cli__run_command {
    cli: "az",
    args: ["resource", "list", "--resource-group", "<rg>", "--output", "json"]
  }
  ```
  For each resource, generate a native `import {}` block (TF >= 1.7):
  ```hcl
  import {
    to   = azurerm_<type>.<label>
    id   = "/subscriptions/.../resourceGroups/<rg>/providers/<provider>/<name>"
  }
  ```
  Write these to `imports.tf` in the Terraform root. Running `terraform plan`
  with import blocks present will reconcile state without destroying resources.
  Remove import blocks once `terraform apply` completes.

  **Why:** skipping this step causes `terraform apply` to attempt creating
  resources that already exist, producing `ResourceAlreadyExists` errors and
  requiring manual `terraform import` calls for each resource.

## 5. Write a run-log entry

Append to `<workspace>/.claude/<project>/run-log.md`:

```markdown
## Preflight — <ISO date>
- az login: ✓ <subscription name>
- SSH key: RSA-4096 at <path>
- RG <name>: exists=<true|false>
- Resources found: <N> (import blocks written to imports.tf)
- TF version: <version>
```

## 6. Hand-offs

- `terraform plan` errors after preflight → `terraform-plan-review`
- 403 / AuthorizationFailed → `azure-rbac-diagnostics`
- CI pipeline failures → `ci-pipeline-debug`
