# Telemetry API (fixture)

CI job `validate` runs `node scripts/validate-kql.mjs` to ensure `api/queries/*.kql` matches `scripts/adx-schema-setup.kql`.

Recent failure on main: validate step exits 1 — schema cross-check reports wrong table/column in `recentErrors.kql`.
