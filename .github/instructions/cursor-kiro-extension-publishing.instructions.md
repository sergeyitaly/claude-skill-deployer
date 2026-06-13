---
name: "cursor-kiro-extension-publishing"
description: "Publish a VS Code-compatible extension to Open VSX for Cursor and Kiro IDE using ovsx. Covers same VSIX as VS Marketplace, OVSX_PAT setup, namespace ownership verification, publish scripts, GitHub Actions, wrong-VSIX pitfalls, and cross-links between registries. Use when publishing to Open VSX, Cursor gallery, Kiro extension registry, or debugging `ovsx publish` failures. Pair with vscode-extension-publishing for packaging and VS Marketplace."
applyTo:
  - "**/PUBLISHING.md"
  - "**/publish-openvsx.js"
  - "**/.github/workflows/publish-extension.yml"
  - "**/00-extension-registries.md"
---

# cursor-kiro-extension-publishing

# Cursor & Kiro: Publish via Open VSX

**Cursor** and **Kiro IDE** install extensions from [Open VSX](https://open-vsx.org/) — not the Visual Studio Marketplace. There is **no separate Kiro marketplace** ([Kiro extension registry docs](https://kiro.dev/docs/editor/extension-registry/)). One Open VSX publish covers both.

Use **`vscode-extension-publishing`** first to build and validate the `.vsix` (`npm run package`, manifest, tests). This skill covers the **second upload** to Open VSX.

## 1. Same package, two registries

| Registry | Editors | Extension listing |
|----------|---------|-------------------|
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) | VS Code | `publisher.name` from `package.json` |
| [Open VSX](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | **Cursor**, **Kiro**, VSCodium, Gitpod | `publisher` / `name` → `namespace/extension` |

Upload the **same** `{name}-{version}.vsix` to both. Bump `package.json` → `version` once per release; both registries reject duplicate versions.

## 2. Find the extension folder

Same as VS Code publishing: run `ovsx` / publish scripts from the directory whose `package.json` has `"engines": { "vscode": ... }` and `"contributes"` (often `extension/`, not repo root).

## 3. One-time Open VSX setup

1. Sign in at [open-vsx.org](https://open-vsx.org/) (GitHub OAuth).
2. Create namespace matching `package.json` → `"publisher"`.
3. Profile → **Access Tokens** → create token → store as **`OVSX_PAT`**. Never commit tokens.
4. First publish may need [Eclipse Foundation review](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).

### Verify namespace (remove unverified warning)

Creating a namespace makes you a **contributor**, not an **owner**. Claim ownership via [Claim namespace form](https://github.com/EclipseFdn/open-vsx.org/issues/new?template=claim-namespace-ownership.yml&namespace=serhiivoinolovych&title=Claiming%20namespace%20%60serhiivoinolovych%60) ([Namespace Access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access)).

## 4. Pre-publish checklist

```powershell
cd extension
npm ci
npm run compile
npm test
npm run package
```

Confirm `{name}-{version}.vsix`. Remove stale `.vsix` files with different names before publishing.

## 5. Publish to Open VSX

```powershell
$env:OVSX_PAT = "<token-from-open-vsx.org>"
npm run publish:openvsx
```

Or: `npx ovsx publish {name}-{version}.vsix -p $env:OVSX_PAT`

Both registries: `npm run publish:all` with `VSCE_PAT` and `OVSX_PAT`.

**Confirm version bump with the user** before publishing.

## 6. GitHub Actions (optional)

Workflow target **`both`** — secrets `VSCE_PAT`, `OVSX_PAT`. See `extension/PUBLISHING.md` and `diagram/00-extension-registries.md`.

## 7. Install paths (for users)

| Editor | Install from |
|--------|----------------|
| VS Code | [VS Marketplace listing](https://marketplace.visualstudio.com/items?itemName=SerhiiVoinolovych.claude-skill-deployer&ssr=false#version-history) |
| Cursor / Kiro | [Open VSX listing](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |

Install `.vsix` via **VS Code / Cursor / Kiro** → Extensions → **Install from VSIX…** — not Visual Studio's VSIX Installer.

## 8. Common errors

| Error | Cause / fix |
|-------|-------------|
| `OVSX_PAT is not set` | Export token before `npm run publish:openvsx`. |
| Wrong extension published | Delete stale `.vsix`; run `npm run package`; verify `{name}-{version}.vsix`. |
| Version already exists | Bump version; publish same semver to both registries. |
| Unverified namespace | Claim ownership on EclipseFdn/open-vsx.org; republish after approval. |
| Works in VS Code but not Cursor | Publish to Open VSX, not Marketplace-only. |

## 9. Hand-offs

- Package, test, VS Marketplace → **`vscode-extension-publishing`**.
- Cross-platform scripts → **`cross-platform-scripting`**.
- CI failures → **`ci-pipeline-debug`** / **`ci-preflight`**.
- Record quirks → **`self-learning`**.
