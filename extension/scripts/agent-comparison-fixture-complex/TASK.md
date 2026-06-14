# Complex agent comparison task

The GitHub Actions job **`validate`** is failing on `main`.

Your goals:
1. **Debug the CI failure** — find which command fails, why, and the root-cause category.
2. **Fix the underlying issue** so `node scripts/validate-kql.mjs` passes locally.
3. **Do not change** `scripts/adx-schema-setup.kql` (it is the canonical ADX schema source of truth).
4. Update only the files needed (likely the KQL query and nothing else unless CI config is wrong).

Deliverables:
- Fixed code on disk
- Short root-cause summary: failing job/step, wrong table/column names (if any), and what you changed

Constraints:
- Kusto table and column names are **case-sensitive**
- The schema file uses `.create table` statements — extract table + column names from there
- Re-run `node scripts/validate-kql.mjs` to verify the fix before finishing
