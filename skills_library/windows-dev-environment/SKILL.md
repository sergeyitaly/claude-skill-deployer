---
name: windows-dev-environment
description: Windows-specific gotchas for Node.js development: BOM from PS5.1 Set-Content, path case-sensitivity (C: vs c:), CRLF/LF shebang issues, and CP1252 mojibake in VS Code output. Use before editing scripts or config on Windows, or when output shows garbled characters.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
---

# Windows Development Environment

Working on this codebase from Windows requires a few extra steps to avoid
encoding and path issues that are either hidden or irrelevant on macOS/Linux.

## 1. PowerShell 5.1 BOM — file writes

`Set-Content -Encoding utf8` in PowerShell 5.1 writes a UTF-8 **BOM**
(`EF BB BF`) at the start of the file. This breaks:
- Node.js `#!/usr/bin/env node` shebangs (first byte becomes BOM, not `#`).
- Any consumer that rejects BOM-prefixed files.

### Do NOT use
```powershell
Set-Content -Path file.txt -Value $content -Encoding utf8   # adds BOM
```

### Do use (PS5.1)
```powershell
[System.IO.File]::WriteAllText($f, $content, [System.Text.UTF8Encoding]::new($false))
```
The `$false` argument means "no BOM".

### Or use .NET directly
```powershell
[System.IO.File]::WriteAllBytes($f, [System.Text.Encoding]::UTF8.GetBytes($content))
```
`WriteAllBytes` strips BOM because raw bytes are written.

### BOM detection / stripping
```powershell
# Check for BOM
$bytes = [System.IO.File]::ReadAllBytes($f)
$hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
if ($hasBom) { Write-Warning "BOM found at start of $f" }

# Strip BOM (rewrite without first 3 bytes)
if ($hasBom) {
  $bytes = $bytes[3..($bytes.Length - 1)]
  [System.IO.File]::WriteAllBytes($f, $bytes)
}
```

## 2. Path case-sensitivity

Windows paths are case-preserving but case-insensitive at the filesystem
level. Node.js `path.resolve()` returns the case as entered by the caller — on
Windows this mixes case freely (e.g., `C:\Users\...` vs `c:\Users\...`).

### Rule
Always compare paths with `.toLowerCase()` on both sides:
```javascript
const target  = path.resolve(targetPath).toLowerCase();
const allowed = path.resolve(allowedDir).toLowerCase();
const isInside = target.startsWith(allowed + path.sep);
```

### Where this matters in this project
The bundled MCP filesystem server (`mcp-servers/filesystem/index.js`) enforces
`allowed-dirs` via `startsWith`. Without `.toLowerCase()` on both sides, an
allowed dir stored as `c:\Users\...` silently blocks an access from `C:\Users\...`.

## 3. Node.js shebangs and CRLF

- `#!/usr/bin/env node` shebangs must be the very first bytes — BOM breaks them.
- CRLF line endings in `.js` files are fine for Node.js, but a `#!/usr/bin/env node`
  shebang + CRLF can confuse some POSIX-aware parsing tools.
- If a `.sh` file has CRLF, Git Bash / WSL will fail with `$'\r': command not found`.

### Recommendations
- For `.js` files with shebangs: use `WriteAllText` (no BOM), store as LF if possible.
- For `.sh` files in repos used cross-platform: `git config core.autocrlf false`
  and add a `.gitattributes` entry:
  ```
  *.sh text eol=lf
  ```
- For `.ps1` files: CRLF is standard on Windows; leave as-is.

## 4. CP1252 vs UTF-8 terminal output

PowerShell's default output encoding on Windows is often CP1252 (or CP437 on
legacy systems). When a script writes Unicode (e.g., em-dash `—`, bullet `•`,
Euro symbol), the console renders mojibake.

### Fix in current session
```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
```

### VS Code terminal
VS Code's integrated terminal uses UTF-8 by default. Issues usually happen in:
- Stand-alone PowerShell / CMD windows.
- Piped output from an external tool (e.g., `python`, `node`) that inherits
  CP1252 code page.
- CI/GitHub Actions runners that do not set UTF-8 output.

### Fix for external tool output
```powershell
chcp 65001
node script.js
```
`65001` = UTF-8 code page.

## 5. Line endings in source files

When contributing to this repo:
- `.ts` / `.json` / `.md` should be LF only (cross-platform convention).
- `.ps1` / `.bat` / `.cmd` can stay CRLF.
- Use the `.gitattributes` to enforce this for committed files.

A `.gitattributes` entry for this project:
```
*.ts text eol=lf
*.json text eol=lf
*.md text eol=lf
*.ps1 text eol=crlf
*.bat text eol=crlf
*.cmd text eol=crlf
```

## 6. Quick checklist before committing from Windows

- [ ] No `.js` / `.ts` file starts with `EF BB BF` BOM bytes.
- [ ] All path comparisons in new JS code use `.toLowerCase()`.
- [ ] Source files use LF (run `node -e "console.log(require('fs').readFileSync('file.ts','utf-8').startsWith('\uFEFF'))"` to check BOM).
- [ ] `.sh` scripts in the project use LF (no CRLF shebangs).
- [ ] PS5.1 scripts use `[System.IO.File]::WriteAllText(...)` for writes.
