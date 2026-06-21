---
applyTo:
  - **/.github/workflows/*.yml
  - **/.github/workflows/*.yaml
---

# github-actions-ci

# GitHub Actions CI

Use when debugging GitHub Actions pipeline failures or reproducing CI stages locally before pushing.

Replaces: `ci-pipeline-debug` and `ci-preflight` (merged in v1.0.83).

## Scope
- Workflows in `.github/workflows/*.yml` / `.github/workflows/*.yaml`
- GitHub Actions runners (ubuntu-latest, windows-latest, macos-latest)
- `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` and other official actions

## Debug Failures

**Step 1 — Read the failing step output:**
```
gh run view <run-id> --log-failed
```
Or open the Actions tab → select the failed run → expand the failed step.

**Step 2 — Reproduce locally (act):**
```
act push --job <job-name> --secret-file .secrets
```

**Step 3 — Common failure patterns:**

| Symptom | Likely Cause | Fix |
|---|---|---|
| `npm ci` fails | `package-lock.json` out of sync | `npm install` locally, commit lockfile |
| `xvfb-run: not found` | Integration test on headless Linux | Add `sudo apt-get install -y xvfb` step |
| TypeScript compile error in CI but not local | Node version mismatch | Align `node-version` across all jobs |
| `ENOENT` on artifact path | `if-no-files-found: error` + build failed | Check prior compile/package step |
| `secret is not set` | PAT not added to repo secrets | Settings → Secrets and variables → Actions |

## Pre-Flight Checklist (run before pushing)

```bash
# Compile
npm run compile

# Unit tests (matches CI unit job)
npm test

# Integration (matches CI integration job — requires xvfb on Linux/WSL)
xvfb-run -a npm run test:integration   # Linux/WSL
npm run test:integration               # Windows (no xvfb needed)

# Package (matches publish job)
npm run package
ls -la *.vsix
```

## Node Version Consistency
Ensure all CI jobs use the same `node-version`. In this repo both `unit` and `integration`
jobs in `ci.yml` must match the version in `publish-extension.yml` (currently Node 22).
Mismatches cause silent test-passes-in-CI / prod-failures.

## Workflow Files in This Repo
- [.github/workflows/ci.yml](../../.github/workflows/ci.yml) — unit + integration tests on push/PR
- [.github/workflows/publish-extension.yml](../../.github/workflows/publish-extension.yml) — VSIX package + Marketplace/Open VSX publish
