import * as path from "node:path";
import { yieldToEventLoop } from "./eventLoop";
import { tryReadValidDashboardSnapshot } from "./dashboardCache";
import { CostPipelineResult } from "./costPipeline";

const inflightDashboardPrecompute = new Map<string, Promise<void>>();

/** Background warm of dashboard-snapshot.json after cost pipeline. */
export function queueDashboardSnapshotPrecompute(
  target: string,
  libraryDir: string,
  pipeline?: CostPipelineResult
): void {
  const key = path.normalize(target);
  if (inflightDashboardPrecompute.has(key)) {
    return;
  }
  if (tryReadValidDashboardSnapshot(target, pipeline)) {
    return;
  }
  const job = (async () => {
    await yieldToEventLoop();
    try {
      const { buildAndCacheDashboardSnapshot } = await import("./costDashboard.js");
      const { runCostPipelineSync } = await import("./costPipeline.js");
      const pipe = pipeline ?? runCostPipelineSync(target, libraryDir);
      buildAndCacheDashboardSnapshot(target, libraryDir, pipe);
    } finally {
      inflightDashboardPrecompute.delete(key);
    }
  })();
  inflightDashboardPrecompute.set(key, job);
}
