---
name: infra-cost-guard
description: Estimate and gate on infrastructure running costs before deploying or leaving resources running — detect expensive resource types in a Terraform plan or live resource list, calculate hourly/daily/monthly estimates, warn before apply, and remind about teardown. Works for Azure, AWS, and GCP. Use before terraform apply on any plan that includes compute, networking (firewalls, NAT gateways, load balancers), or managed databases.
user-invocable: true
allowed-tools:
  - mcp__claude-skills-cli__run_command
  - mcp__filesystem__read_file
  - mcp__filesystem__write_file
  - mcp__filesystem__search_files
  - Glob
  - Grep
---

# Infra Cost Guard

Prevents surprise cloud bills by estimating cost before `apply` and reminding
about teardown when expensive resources are running.

## 1. Detect expensive resources in the plan

After `terraform plan` produces output, scan it for these resource types:

### Azure

| Resource type | Approx cost |
|---|---|
| `azurerm_firewall` Standard SKU | ~$1.10–1.30/hr (~$26/day) |
| `azurerm_firewall` Premium SKU | ~$2.50/hr |
| `azurerm_application_gateway` WAF_v2 | ~$0.35/hr + data |
| `azurerm_nat_gateway` | ~$0.045/hr + data |
| `azurerm_virtual_machine` — check size: B-series < D-series < E/F-series | varies |
| `azurerm_kubernetes_cluster` | control plane ~$0.10/hr + node pool |
| `azurerm_sql_database` / `azurerm_mssql_database` | GP tier ~$0.38/vCore/hr |
| `azurerm_cosmosdb_account` | ~$0.008/RU/s/hr |

### AWS

| Resource type | Approx cost |
|---|---|
| `aws_nat_gateway` | ~$0.045/hr + $0.045/GB |
| `aws_lb` (ALB/NLB) | ~$0.008/hr + LCU |
| `aws_rds_instance` | db.t3.medium ~$0.068/hr |
| `aws_eks_cluster` | ~$0.10/hr control plane |
| `aws_elasticsearch_domain` / `aws_opensearch_domain` | instance + storage |

### GCP

| Resource type | Approx cost |
|---|---|
| `google_compute_instance` — n2/c2 series | varies |
| `google_container_cluster` | ~$0.10/hr Autopilot base |
| `google_sql_database_instance` | db-n1-standard-2 ~$0.10/hr |
| `google_cloud_run_v2_service` | per-request, check min-instances |

## 2. Before apply: emit a cost summary

When one or more expensive resources are detected, output:

```
⚠ Cost gate — resources with ongoing charges:
  azurerm_firewall.fw (Standard): ~$1.20/hr (~$28.80/day, ~$864/mo)
  azurerm_linux_virtual_machine.vm (Standard_B2s_v2): ~$0.10/hr

  Total estimate: ~$1.30/hr (~$31.20/day)
  Subscription: <name from subscription.json if available>

Confirm: these resources will accrue charges until destroyed.
Teardown: terraform destroy -auto-approve (from <tf-root>)
```

Do **not** block apply — this is informational. State the teardown command
explicitly so it can be copy-pasted.

## 3. Write a teardown reminder

After a successful `terraform apply`, write a teardown note to the project's
run-log:

```markdown
## Teardown reminder — <ISO date>
Resources running since apply: ~$<rate>/hr accruing.
Stop charges: `terraform destroy -auto-approve` from `<tf-root>`
Estimated charge if left running 24h: ~$<24h cost>
```

## 4. Live resource cost check (without a plan)

If asked to estimate cost for already-running resources:

**Azure:**
```
mcp__claude-skills-cli__run_command {
  cli: "az",
  args: ["resource", "list", "--resource-group", "<rg>", "--output", "json",
         "--query", "[].{name:name,type:type,sku:sku}"]
}
```
Match the returned types against the table in section 1.

**AWS:**
```
mcp__claude-skills-cli__run_command {
  cli: "aws",
  args: ["ce", "get-cost-and-usage", "--time-period",
         "Start=<YYYY-MM-DD>,End=<YYYY-MM-DD>",
         "--granularity", "DAILY", "--metrics", "BlendedCost"]
}
```

**GCP:**
```
mcp__claude-skills-cli__run_command {
  cli: "gcloud",
  args: ["billing", "accounts", "list"]
}
```

## 5. Rules

- Always emit the teardown command alongside any cost warning — it reduces
  the friction of stopping resources.
- Do not refuse to deploy expensive resources; the user decides. Your job
  is to make costs visible before apply, not to block work.
- Prices are estimates. For exact rates use the cloud provider's pricing
  calculator or Cost Management tools.
- For long-running demo/test environments (firewall, K8s, databases), suggest
  scheduling a destroy or setting an auto-shutdown policy.
