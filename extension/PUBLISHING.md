# Publishing Claude Skills Manager

This extension ships to two registries from the same `.vsix`:

| Registry | Editors | Listing |
|---|---|---|
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) | VS Code | `serhiivoinolovych.claude-skill-deployer` |
| [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | Cursor, Kiro, VSCodium, Gitpod | `serhiivoinolovych/claude-skill-deployer` |

## Current state (as of this writing)

- The Marketplace listing is real and updated, but **only ever via a manual
  local `vsce publish`** run by someone with the token on their own machine —
  not via this repo's CI.
- The `.github/workflows/publish-extension.yml` GitHub Actions pipeline has
  **never successfully published anything**. Its one and only run
  (`v1.0.45`, 2026-06-14) failed because neither `VSCE_PAT` nor `OVSX_PAT`
  was configured as a repository secret. The workflow was patched minutes
  later (commit `c264985`) to *not hard-fail* on a tag push when secrets are
  missing — it now just packages the `.vsix`, uploads it as a build artifact,
  and warns instead of erroring — but **no tag has been pushed since**, so
  that fix itself has never actually been exercised.
- Net effect: pushing a `vX.Y.Z` tag today will build and test the extension
  and hand you a downloadable `.vsix` artifact from the Actions run, but will
  **not** publish anywhere until the two secrets below are added.

## One-time setup: repository secrets

Add both as GitHub Actions secrets (Settings → Secrets and variables →
Actions → New repository secret), or via `gh secret set <NAME>`:

### `VSCE_PAT` (Visual Studio Marketplace)

1. Publisher `serhiivoinolovych` must already exist at
   https://marketplace.visualstudio.com/manage (must match
   `extension/package.json`'s `"publisher"`).
2. Generate a Personal Access Token in Azure DevOps
   (https://dev.azure.com → User settings → Personal access tokens) with
   **Marketplace: Manage** scope, organization "All accessible organizations".
3. `gh secret set VSCE_PAT` and paste the token — never commit it or put it
   in a tracked file.

### `OVSX_PAT` (Open VSX — Cursor + Kiro)

1. Sign in at https://open-vsx.org/ (GitHub OAuth).
2. Namespace `serhiivoinolovych` must exist and match `package.json`'s
   `"publisher"`.
3. Profile → Access Tokens → create token.
4. `gh secret set OVSX_PAT` and paste the token.
5. Namespace ownership (not just "contributor") controls the "verified"
   badge — see the namespace-claim flow in the
   `cursor-kiro-extension-publishing` skill if that matters to you; it does
   not block publishing.

## Releasing

1. Bump `extension/package.json`'s `"version"`, add a matching
   `## [x.y.z]` section to `extension/CHANGELOG.md`, and a `## What's new in
   x.y.z` section to `extension/README.md` — see the
   `extension-release-notes` skill for the exact convention.
2. Commit, then push a tag matching the version:
   ```bash
   git tag v1.0.129
   git push origin v1.0.129
   ```
   This triggers `publish-extension.yml`, which compiles, tests, packages,
   and — once the secrets above exist — publishes to both registries.
3. No secrets yet, or want a dry run first? Trigger the workflow manually
   from the Actions tab (`workflow_dispatch`) with `publish_target: dry-run`
   to just build and test without publishing, or `marketplace` /
   `open-vsx` to publish to only one registry.
4. Confirm both registries show the new version (Marketplace listing above
   updates within a few minutes; Open VSX can lag longer).

## Manual publish (fallback, e.g. no CI access)

From `extension/`:

```powershell
npm ci
npm run compile
npm test
npm run package                      # produces claude-skill-deployer-<version>.vsix

npx vsce publish -p <VSCE_PAT>                                    # Marketplace
npx ovsx publish claude-skill-deployer-<version>.vsix -p <OVSX_PAT>  # Open VSX
```

Publishing is a one-way, publicly-visible action — always confirm the
version and target registry before running either publish command.

## Related skills

- `vscode-extension-publishing` — packaging, manifest fields, Marketplace
  PAT setup, common `vsce` errors.
- `cursor-kiro-extension-publishing` — Open VSX specifics, namespace
  ownership/verification.
- `extension-release-notes` — keeping `package.json`/`CHANGELOG.md`/
  `README.md` versions in sync before a release.
