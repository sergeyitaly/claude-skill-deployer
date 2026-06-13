# Publishing Claude Skills Manager

The extension ships to **two registries**. Same `.vsix`, two uploads per release.

| Registry | Used by | Extension listing | Publisher / namespace |
|----------|---------|-------------------|------------------------|
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/) | VS Code | [claude-skill-deployer](https://marketplace.visualstudio.com/items?itemName=serhiivoinolovych.claude-skill-deployer) | [serhiivoinolovych](https://marketplace.visualstudio.com/publishers/serhiivoinolovych) |
| [Open VSX](https://open-vsx.org/) | **Cursor**, **Kiro IDE**, VSCodium, Gitpod | [claude-skill-deployer](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [serhiivoinolovych](https://open-vsx.org/namespace/serhiivoinolovych) |

**Navigate:** VS Marketplace listing ↔ [Open VSX listing](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) · Distribution diagram: [diagram/00-extension-registries.md](../diagram/00-extension-registries.md) · User install guide: [README.md](README.md)

Kiro IDE uses Open VSX as its default extension gallery ([Kiro extension registry docs](https://kiro.dev/docs/editor/extension-registry/)). There is **no separate Kiro marketplace** — one Open VSX publish covers both Cursor and Kiro.

## One-time setup

### 1. Visual Studio Marketplace

1. Create a [publisher](https://marketplace.visualstudio.com/manage) named **`serhiivoinolovych`** (must match `package.json` → `publisher`).
2. Create a [Personal Access Token](https://dev.azure.com/) with **Marketplace → Manage** scope.
3. Store as GitHub secret **`VSCE_PAT`** (or export locally as `VSCE_PAT`).

### 2. Open VSX (Cursor + Kiro)

1. Sign in at [open-vsx.org](https://open-vsx.org/) (GitHub OAuth).
2. Create namespace **`serhiivoinolovych`** (must match `package.json` → `publisher`).
3. Profile → **Access Tokens** → create token.
4. Store as GitHub secret **`OVSX_PAT`** (or export locally as `OVSX_PAT`).

First publish to a new namespace may require [Eclipse Foundation review](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).

#### Verify the namespace (remove ⚠️ “unverified”)

Creating a namespace only makes you a **contributor**. Extensions show as **verified** (shield icon) only when the namespace has at least one **owner** and you publish as a namespace member ([Namespace Access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access)).

**Claim ownership** (one-time, public):

1. Log in at [open-vsx.org](https://open-vsx.org/) with the same GitHub account you use to publish.
2. Open the official claim form (namespace pre-filled):  
   [Claim namespace `serhiivoinolovych`](https://github.com/EclipseFdn/open-vsx.org/issues/new?template=claim-namespace-ownership.yml&namespace=serhiivoinolovych&title=Claiming%20namespace%20%60serhiivoinolovych%60)
3. Fill the template (see checklist below). Eclipse reviews on [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues).
4. After approval, confirm **Settings → Namespaces → `serhiivoinolovych`** shows you as **Owner**, then republish if needed.

**Template checklist (Option 1 — fastest for this project):**

| Field | What to select |
|-------|----------------|
| Namespace | `serhiivoinolovych` (pre-filled) |
| Ownership | ✓ Namespace is not currently owned on Open VSX |
| Account age | ✓ GitHub ID has ≥ 12 months public history |
| Option 1 | ✓ VS Code Marketplace publisher with repo in `package.json` |
| Validation | ✓ Repo owned by your GitHub org **or** paste a commit URL by you in the public repo |
| Claim evidence | Publisher: https://marketplace.visualstudio.com/publishers/serhiivoinolovych · Extension: https://marketplace.visualstudio.com/items?itemName=serhiivoinolovych.claude-skill-deployer · Repo: https://github.com/sergeyitaly/claude-skill-deployer |

If your GitHub user is not in the `sergeyitaly` org, use **Option 1 → commit URL** in Claim evidence (a link to a commit you authored in that repo).

You can also manage members under **Settings → Namespaces** once you are an owner (add CI bot accounts as **Contributor** only).

**Note:** Publishing works while unverified; Cursor/Kiro may show a warning banner until ownership is claimed.

### 3. GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `VSCE_PAT` | `vsce publish` |
| `OVSX_PAT` | `ovsx publish` |

## Release workflow

### Option A — GitHub Actions (recommended)

**Manual:**

1. Bump `version` in `extension/package.json` and update `CHANGELOG.md`.
2. Commit and push to `main`.
3. **Actions → Publish Extension → Run workflow** → target **`both`**.

**Tag (publishes to both registries automatically):**

```bash
git tag v1.0.21
git push origin v1.0.21
```

Use tag **`v*`** (e.g. `v1.0.20`) — the workflow runs on tag push.

**Dry-run (package only, no upload):**

Run workflow with target **`dry-run`**. Download the VSIX from workflow artifacts.

### Option B — Local publish

```powershell
cd extension
npm ci
npm run compile
npm run package

# VS Marketplace
$env:VSCE_PAT = "<your-azure-devops-pat>"
npm run publish:marketplace

# Open VSX (Cursor + Kiro)
$env:OVSX_PAT = "<your-open-vsx-pat>"
npm run publish:openvsx
```

Or both:

```powershell
npm run publish:all
```

(requires both env vars set)

`publish:openvsx` uploads **`{package.json name}-{version}.vsix`** only (e.g. `claude-skill-deployer-1.0.20.vsix`). Remove unrelated old `.vsix` files in `extension/` before publishing.

## Version bumps

Each registry rejects duplicate versions. Always bump `extension/package.json` → `version` before publishing (e.g. `1.0.20` → `1.0.21`).

Publish **the same version** to both registries in one release so Cursor/Kiro and VS Code users stay aligned.

## Install links (after publish)

| Editor | Primary registry | Listing | Also available on |
|--------|------------------|---------|-------------------|
| VS Code | [Visual Studio Marketplace](https://marketplace.visualstudio.com/) | [claude-skill-deployer](https://marketplace.visualstudio.com/items?itemName=serhiivoinolovych.claude-skill-deployer) | [Open VSX ↗](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) |
| Cursor / Kiro | [Open VSX](https://open-vsx.org/) | [claude-skill-deployer](https://open-vsx.org/extension/serhiivoinolovych/claude-skill-deployer) | [VS Marketplace ↗](https://marketplace.visualstudio.com/items?itemName=serhiivoinolovych.claude-skill-deployer) |

Deep link (VS Code only): `vscode:extension/serhiivoinolovych.claude-skill-deployer`

## Kiro without the extension UI

Kiro can still use **synced skill files** (`.kiro/skills/`, `.kiro/hooks/`) when the repo was configured from VS Code/Cursor or the CLI — but for the full manager UI in Kiro IDE, install from Open VSX as above.
