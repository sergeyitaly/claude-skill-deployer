---
name: vscode-extension-publishing
description: Create, package, test, and publish a VS Code extension to the Marketplace using @vscode/vsce. Covers package.json manifest fields, .vscodeignore, local debugging (Extension Development Host), vsce package/publish, version bumps, publisher/PAT setup, and common publish errors. Use when building a new VS Code extension, preparing a release, or debugging `vsce package`/`vsce publish` failures.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# VS Code Extension: Build & Publish

## 1. Find the extension manifest

The extension's `package.json` is the one with `"engines": { "vscode": ... }`
and a `"contributes"` section — it's often **not** the repo root (e.g. it
lives in `extension/package.json` while the repo root has its own
`package.json` or none at all). Run all `vsce`/`npm` commands from the
directory containing *that* `package.json`.

```bash
grep -rl '"engines"' --include=package.json .
```

## 2. Required manifest fields

At minimum, `package.json` needs:

```jsonc
{
  "name": "my-extension",          // lowercase, no spaces - the extension ID
  "displayName": "My Extension",   // shown in the Marketplace
  "description": "...",
  "version": "0.1.0",               // must be bumped for every publish
  "publisher": "my-publisher-id",   // must match a registered Marketplace publisher
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "main": "./out/extension.js",     // compiled entry point
  "icon": "resources/icon.png",     // 128x128 PNG, required for Marketplace listing
  "repository": { "type": "git", "url": "https://github.com/<org>/<repo>.git" },
  "activationEvents": ["onStartupFinished"],
  "contributes": { /* commands, views, menus, configuration, etc. */ }
}
```

`license`, `bugs`, and `homepage` are optional but recommended for the
Marketplace listing page.

## 3. Local development & testing

```powershell
npm install
npm run compile     # tsc -p ./ (or your build script)
npm run watch        # incremental rebuild while developing
```

Press **F5** (with the extension folder open as the workspace root) to
launch an **Extension Development Host** — a second VS Code window with the
extension loaded, for manual testing. Reload it with `Ctrl+R`/`Cmd+R` after
recompiling.

## 4. `.vscodeignore`

Controls what's included in the packaged `.vsix` (everything *not* matched
is excluded — opposite of `.gitignore`). Typically exclude source, configs,
and dev tooling so the package only ships compiled output + metadata:

```
.vscode/**
.vscode-test/**
src/**
**/*.ts
**/*.map
.gitignore
.eslintrc*
tsconfig.json
node_modules/**
**/*.test.js
```

Keep `out/**` (or `dist/**`), `package.json`, `README.md`, `CHANGELOG.md`,
`LICENSE`, and `resources/**` (icons) **in** the package.

## 5. Packaging

```powershell
npx vsce package
```

Produces `<name>-<version>.vsix`. Sanity-check it:

```powershell
npx vsce ls          # lists exactly what will be included
```

If the package is unexpectedly large, check `.vscodeignore` for missing
entries (commonly `node_modules/**` for devDependencies, or `.git/**`).

## 6. Pre-publish checklist (release gate)

Run these **before** `vsce publish` (from a bumped `package.json` version).
In monorepos where the extension lives in `extension/`, `cd` there for
`npm test` / `npm run package`; run `validate-release.mjs` from the **repo
root** (it `cd`s into `extension/` internally).

```powershell
# 1. Verify all tests pass
cd extension
npm test

# Output should show:
#   Tests  N passed (N)

# 2. Validate release (repo root — checks CHANGELOG, compile, tests, smoke, audit)
cd ..
node scripts/validate-release.mjs

# 3. Package VSIX
cd extension
npm run package
```

Step 2 is the full gate: semver in `extension/package.json`, a matching
`## [version]` section in `CHANGELOG.md`, `npm run compile`, `npm test`,
`scripts/smoke-test.mjs`, and `npm audit --omit=dev`. Fix any `FAIL:` line
before publishing. Step 1 is a quick local check; step 3 produces
`<name>-<version>.vsix` for manual install or upload.

## 7. Publisher account & access token

1. Create a Marketplace publisher at
   https://marketplace.visualstudio.com/manage (publisher ID must match
   `package.json`'s `"publisher"`).
2. Generate a **Personal Access Token** in Azure DevOps
   (https://dev.azure.com -> User settings -> Personal access tokens) with
   **Marketplace: Manage** scope, organization "All accessible organizations".
3. Treat the PAT like a password:
   - Never commit it to the repo or write it into tracked files.
   - Prefer `npx vsce login <publisher>` (stores it via the OS credential
     manager) over passing `--pat` on the command line, which can leak into
     shell history.
   - If a PAT does end up in a file (even a gitignored one), tell the user
     to rotate it.

## 8. Version bumps and publishing

The Marketplace **rejects re-publishing an existing version** — bump the
version first. `vsce publish` can do both in one step:

```powershell
npx vsce publish patch   # 0.1.0 -> 0.1.1
npx vsce publish minor   # 0.1.0 -> 0.2.0
npx vsce publish major   # 0.1.0 -> 1.0.0
# or publish the version already in package.json:
npx vsce publish
```

Each of these updates `package.json`'s `"version"` (and creates a git tag,
unless `--no-git-tag-version` is passed) before uploading.

**Always confirm the version bump with the user before running `vsce
publish`** — it's a one-way action visible on the Marketplace and changes
the repo's `package.json`/git tags.

## 9. Common errors

| Error | Cause / fix |
|---|---|
| `Extension manifest not found` | Running `vsce` from the wrong directory — `cd` into the folder containing the extension's `package.json` (see step 1). |
| `Version already exists in the marketplace` | The version in `package.json` was already published — bump it (step 8); ask the user which bump (patch/minor/major) if not specified. |
| `Make sure to edit the README.md file before you publish your extension` | Default placeholder README wasn't replaced — write a real one. |
| `Missing publisher name` | `"publisher"` missing from `package.json`, or doesn't match a publisher you're logged in as. |
| Icon/banner errors | `icon` must be a PNG (not SVG) at the path given, typically 128x128. |

## 10. Hand-offs

- **Cursor / Kiro / Open VSX** (second registry, `ovsx publish`, namespace
  verification) → `cursor-kiro-extension-publishing`.
- Cross-platform packaging/build script issues (PS5.1 vs bash vs macOS) →
  `cross-platform-scripting`.
- Record any project-specific publish quirks (publisher ID, PAT scope
  gotchas, packaging exclusions) via `self-learning` so the next release
  doesn't rediscover them.
