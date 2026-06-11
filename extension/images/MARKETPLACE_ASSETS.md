# Marketplace assets

Capture from **Extension Development Host** (F5 from `extension/`). Helper: `scripts/capture-marketplace-assets.ps1`.

| File | Size | Content |
|------|------|---------|
| `icon.png` | 128x128 | Extension icon (also copy to `resources/icon.png` for package.json) |
| `screenshot-dashboard.png` | 1280x800 | Cost Intelligence Dashboard WebView |
| `screenshot-skills-tree.png` | 1280x800 | Skills tree with ROI labels |
| `screenshot-budget-controls.png` | 1280x800 | Budget settings + status bar |
| `demo.gif` | max 10MB | Short flow: install library → detect skills → dashboard |

## Capture steps

1. Open Extension Development Host (`F5` from `extension/`).
2. Run onboarding or install skills on a sample repo.
3. Open **Cost Intelligence Dashboard** and screenshot.
4. Show skills tree with **Cycle Skill Sort** set to `highest_roi`.
5. Record GIF with built-in screen recorder (Windows: Win+G).

Add screenshot paths to `package.json` under `contributes.galleryBanner` / `qna` as needed for Marketplace listing.
