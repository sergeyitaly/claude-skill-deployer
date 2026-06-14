import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAndCacheDashboardSnapshot } from "./costDashboard";
import { runCostPipelineSync } from "./costPipeline";
import {
  dashboardSnapshotPath,
  tryReadValidDashboardSnapshot,
} from "./dashboardSnapshotCache";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dash-snap-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, ".claude", "learning"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "learning", "runs.jsonl"), "", "utf-8");
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("dashboardSnapshotCache", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("fast-phase read returns cached main body after build", () => {
    const target = makeWorkspace();
    const pipeline = runCostPipelineSync(target, libraryDir);
    buildAndCacheDashboardSnapshot(target, libraryDir, pipeline);
    expect(fs.existsSync(dashboardSnapshotPath(target))).toBe(true);

    const t0 = performance.now();
    const hit = tryReadValidDashboardSnapshot(target, pipeline);
    const elapsed = performance.now() - t0;

    expect(hit?.mainBodyHtml.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(30);
  });
});
