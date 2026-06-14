import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as attributionHealth from "./attributionHealth";
import {
  attributionTrustPath,
  readLowTrustPromptSettings,
  syncAttributionTrustConfig,
} from "./attributionTrustConfig";

const repoLibraryDir = path.join(__dirname, "..", "..", "skills_library");
const extLibraryDir = path.join(__dirname, "..", "skills_library");
const resolvedLibraryDir = fs.existsSync(path.join(repoLibraryDir, "agents.json"))
  ? repoLibraryDir
  : extLibraryDir;

const workspaces: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trust-cfg-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, ".claude", "learning"), { recursive: true });
  return root;
}

describe("readLowTrustPromptSettings", () => {
  it("returns defaults when settings are unset", () => {
    const settings = readLowTrustPromptSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.thresholdPct).toBe(50);
  });
});

describe("syncAttributionTrustConfig", () => {
  it("writes shouldInject when score is below threshold", () => {
    const target = makeWorkspace();
    vi.spyOn(attributionHealth, "assessAttributionHealth").mockReturnValue({
      reliable: false,
      staleEqualSplit: false,
      highUnattributedRatio: false,
      noPerSkillData: true,
      v2HookRuns: 0,
      confidenceScore: 0.35,
      confidenceLevel: "low",
      summary: "No per-skill cost data yet.",
    });

    const result = syncAttributionTrustConfig(target, resolvedLibraryDir);
    expect(result?.shouldInject).toBe(true);
    expect(result?.scorePct).toBeLessThan(50);

    const onDisk = JSON.parse(fs.readFileSync(attributionTrustPath(target), "utf-8")) as {
      shouldInject: boolean;
    };
    expect(onDisk.shouldInject).toBe(true);
  });

  it("does not inject when score is above threshold", () => {
    const target = makeWorkspace();
    vi.spyOn(attributionHealth, "assessAttributionHealth").mockReturnValue({
      reliable: true,
      staleEqualSplit: false,
      highUnattributedRatio: false,
      noPerSkillData: false,
      v2HookRuns: 6,
      confidenceScore: 0.94,
      confidenceLevel: "high",
      summary: "High confidence — v2 hooks logged 6 invoke(s).",
    });

    const result = syncAttributionTrustConfig(target, resolvedLibraryDir);
    expect(result?.shouldInject).toBe(false);
    expect(result?.scorePct).toBeGreaterThanOrEqual(50);
  });
});
