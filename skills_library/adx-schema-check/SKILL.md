---
name: adx-schema-check
description: Cross-check KQL/Kusto queries in application code against the canonical ADX (Azure Data Explorer) table/column schema definitions, and optionally against the live cluster. Flags table/column name mismatches before they cause runtime query failures. Use when working on ADX/Kusto-backed API routes, debugging "table not found"/"column not found" errors, or after changing the schema.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
---

# ADX / Kusto Schema Check

Cross-checks code-side KQL queries against the source-of-truth schema, since
table/column name typos or renames are a common source of silent or 400-level
ADX query failures.

## 1. Find the source-of-truth schema

Look for the canonical schema definition, typically one or both of:
- A KQL setup script (e.g. `scripts/adx-schema-setup.kql`) with `.create table`
  statements.
- A Terraform-managed schema (e.g. `modules/data/adx_schema.tf` using
  `azurerm_kusto_*` or `azapi` resources with embedded KQL).

Extract from these: table names and, per table, column names + types.

## 2. Find code-side KQL usage

Grep the application/API code for KQL constructs:
- Table references (bare identifiers used as the first pipe-stage source, e.g.
  `TableName | where ...`).
- Column references after `where`, `project`, `extend`, `summarize`, `order by`,
  `join on`, etc.
- Look in API route handlers, query-builder helper functions, and any
  `.kql` files.

## 3. Cross-check and report

For each query found:
- Does the table name exist in the schema? (Case-sensitive — Kusto identifiers
  are case-sensitive.)
- Do referenced columns exist on that table with matching names?
- Report mismatches as `file:line` — schema says `X`, query uses `Y`.

Common failure pattern: a schema migration renames a table/column but one query
site is missed. Search for *all* occurrences of the old and new names to confirm
consistency project-wide, not just the file you started in.

## 4. Optional: live cluster drift check

If the project's conventions allow ADX access (via Key Vault + Managed Identity —
**never via connection strings in code**), confirm the deployed schema matches the
source files:
```kql
.show table <TableName> schema as json
```
If the live cluster differs from the schema source files, that's infra drift —
flag it separately from code-side mismatches.

## 5. Fixing mismatches

- If the schema files are the intended source of truth, fix the **query side** to
  match.
- If you change the schema (table/column names) instead, you must update *every*
  query referencing the old names — re-run this whole check afterward to confirm
  nothing was missed, and check whether any project rules require keeping
  schema/query names in sync as a hard constraint.
