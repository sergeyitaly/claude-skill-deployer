export interface PerfSample {
  op: string;
  ms: number;
  at: string;
  meta?: Record<string, unknown>;
}

export interface PerfPercentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

const MAX_SAMPLES = 500;
const samples: PerfSample[] = [];

const TARGETS_MS: Record<string, number> = {
  "toggle-ui": 16,
  "tree-refresh": 10,
  "workspace-sync-total": 150,
  "dashboard-open": 30,
};

function perfLoggingEnabled(): boolean {
  return process.env.CLAUDE_SKILLS_PERF === "1";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export function getPerfPercentiles(op?: string): PerfPercentiles {
  const filtered = op ? samples.filter((s) => s.op === op) : samples;
  const values = filtered.map((s) => s.ms).sort((a, b) => a - b);
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

function maybeLogPercentiles(op: string): void {
  if (!perfLoggingEnabled()) {
    return;
  }
  const stats = getPerfPercentiles(op);
  if (stats.count < 5) {
    return;
  }
  const target = TARGETS_MS[op];
  const targetNote = target !== undefined ? ` target<${target}ms` : "";
  console.log(
    `[claude-skills perf] ${op} p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms p99=${stats.p99.toFixed(1)}ms n=${stats.count}${targetNote}`
  );
}

export function recordPerf(op: string, ms: number, meta?: Record<string, unknown>): void {
  samples.push({ op, ms, at: new Date().toISOString(), meta });
  if (samples.length > MAX_SAMPLES) {
    samples.shift();
  }
  if (perfLoggingEnabled()) {
    const extra = meta ? ` ${JSON.stringify(meta)}` : "";
    const target = TARGETS_MS[op];
    const warn = target !== undefined && ms > target ? " SLOW" : "";
    console.log(`[claude-skills perf] ${op}: ${ms.toFixed(1)}ms${warn}${extra}`);
  }
  maybeLogPercentiles(op);
}

export function measureSync<T>(op: string, fn: () => T, meta?: Record<string, unknown>): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordPerf(op, performance.now() - t0, meta);
  }
}

export function getPerfSamples(): readonly PerfSample[] {
  return samples;
}

/** @internal */
export function resetPerfTelemetryForTests(): void {
  samples.length = 0;
}
