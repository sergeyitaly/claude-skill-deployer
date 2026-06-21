---
applyTo:
  - **/vitest.config.ts
  - **/*.bench.test.ts
  - **/*.solo.test.ts
  - **/src/**/*.test.ts
---

# vitest-extension-testing

# Vitest Extension Testing

Use when running, debugging, or interpreting Vitest test results in the claude-skills-deployer extension (`extension/` directory).

## Test File Naming Conventions

| Pattern | What it tests | Run command |
|---|---|---|
| `*.test.ts` | Standard unit tests | `npm test` |
| `*.bench.test.ts` | Latency benchmarks (p95, avg, min/max) | `npx vitest run src/foo.bench.test.ts` |
| `*.solo.test.ts` | Tests that must not run in parallel | `npx vitest run --pool=forks src/foo.solo.test.ts` |
| `*.prune.test.ts` | Data cleanup / pruning logic | `npm test` |
| `*.integration.test.ts` | VS Code Extension Host tests (require xvfb) | `npm run test:integration` |

## Common Failures and Fixes

**`Cannot find module 'vscode'`**
Extension tests mock the vscode API. If this fires unexpectedly, check `src/test/` for the mock setup.

**`Cannot find module './foo'`**
Run `npm run compile` first — the `.ts` files must be compiled before Vitest can resolve them via the tsconfig paths.

**`xvfb-run: not found`** (Linux/WSL)
```bash
sudo apt-get install -y xvfb
```

**Bench p95 regression**
Benchmarks in `*.bench.test.ts` report `min / avg / p95 / max`. A p95 regression (>50ms for read_file, >200ms for tools/list) usually indicates blocking I/O or a synchronous loop in the hot path of `index.js`.

**Parallel timeout in `*.solo.test.ts`**
These tests must run with `--pool=forks` to prevent shared state corruption. If they timeout in the default thread pool, run:
```bash
npx vitest run --pool=forks src/foo.solo.test.ts
```

**`ENOENT` on temp dir after test**
`afterAll` cleanup with `fs.rmSync(dir, { recursive: true, force: true })` — ensure `tmpDir` is created in `beforeAll` not at module level.

## Run Commands

```bash
# All unit tests (fastest feedback loop)
cd extension && npm test

# Single file
npx vitest run src/mcpUsageLog.test.ts

# Benchmark (spawns MCP server subprocess)
npx vitest run src/mcpFilesystemServer.bench.test.ts

# Integration (VS Code Extension Host — requires display)
npm run test:integration                    # Windows
xvfb-run -a npm run test:integration       # Linux/WSL/CI
```

## Test Coverage Hotspots

Files with the most test coverage to check when refactoring:
- `src/mcpUsageLog.ts` — `mcpUsageLog.test.ts`
- `src/skillLifecycle.ts` — `skillLifecycle.test.ts`
- `src/taskSkillProposals.ts` — `taskSkillProposals.test.ts`
- `src/costPipeline.ts` — `costPipeline.test.ts`
- `extension/resources/mcp-servers/filesystem/index.js` — `mcpFilesystemServer.bench.test.ts`

## Adding a New Test

1. Create `src/myModule.test.ts`
2. Import from vitest: `import { describe, expect, it } from "vitest"`
3. Use `fs.mkdtempSync` for temp dirs; clean up in `afterAll`
4. Run `npm test` to confirm it appears in the suite output
