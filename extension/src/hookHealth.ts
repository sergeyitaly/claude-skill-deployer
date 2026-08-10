import * as fs from "node:fs";
import * as path from "node:path";

const HOOK_HEALTH_REL = path.join(".claude", "learning", "hook-health.jsonl");

export interface HookHealthRecord {
  ts: string;
  event: "hook_fired" | "hook_request";
  skill?: string | null;
  wrote_runs?: boolean;
  agent: string;
  session_id?: string;
  error?: string;
  /** "hook_request" only — which route was dispatched (e.g. "skill-invoke", "session-stop"). */
  hookName?: string;
  /**
   * "hook_request" only — wall-clock time (ms) handleHookRequest() took inside the hook
   * server. Does not include curl subprocess spawn or network round-trip on the caller's
   * side, but is the one number this codebase can actually measure and has never recorded
   * before — added specifically so a stalled/slow local server (e.g. from parsing large
   * .jsonl files synchronously) leaves a trace instead of being invisible.
   */
  durationMs?: number;
}

export function hookHealthPath(target: string): string {
  return path.join(target, HOOK_HEALTH_REL);
}

export function appendHookHealth(
  target: string,
  record: Omit<HookHealthRecord, "ts">
): void {
  const file = hookHealthPath(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
      "utf-8"
    );
  } catch { /* non-fatal — health tracking must never break hook execution */ }
}

export interface HookHealthSummary {
  hookCallsToday: number;
  skillDetectionsToday: number;
  recordsWrittenToday: number;
  writeSuccessRate: number;
  lastWriteTs: string | null;
  hasData: boolean;
  /** From "hook_request" records — server-side handleHookRequest() duration, ms. */
  latency: {
    requestsToday: number;
    avgDurationMs: number;
    maxDurationMs: number;
    /** Requests over SLOW_HOOK_MS today — the thing that was previously invisible. */
    slowCallsToday: number;
    hasData: boolean;
  };
}

/** A single hook dispatch taking longer than this is worth surfacing, not just logging. */
export const SLOW_HOOK_MS = 2000;

export function computeHookHealthSummary(target: string): HookHealthSummary {
  const emptyLatency = {
    requestsToday: 0, avgDurationMs: 0, maxDurationMs: 0, slowCallsToday: 0, hasData: false,
  };
  const file = hookHealthPath(target);
  if (!fs.existsSync(file)) {
    return {
      hookCallsToday: 0,
      skillDetectionsToday: 0,
      recordsWrittenToday: 0,
      writeSuccessRate: 100,
      lastWriteTs: null,
      hasData: false,
      latency: emptyLatency,
    };
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const cutoff = dayStart.getTime();

  let hookCallsToday = 0;
  let skillDetectionsToday = 0;
  let recordsWrittenToday = 0;
  let writesAttempted = 0;
  let lastWriteTs: string | null = null;
  let requestsToday = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let slowCallsToday = 0;

  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as HookHealthRecord;
        if (new Date(r.ts).getTime() < cutoff) continue;

        if (r.event === "hook_request") {
          if (typeof r.durationMs === "number") {
            requestsToday++;
            totalDurationMs += r.durationMs;
            maxDurationMs = Math.max(maxDurationMs, r.durationMs);
            if (r.durationMs >= SLOW_HOOK_MS) slowCallsToday++;
          }
          continue;
        }

        // event === "hook_fired" (skill-invoke-specific outcome, not a generic request record)
        hookCallsToday++;
        if (r.skill !== null && r.skill !== undefined) {
          skillDetectionsToday++;
          writesAttempted++;
          if (r.wrote_runs) {
            recordsWrittenToday++;
            lastWriteTs = r.ts;
          }
        }
      } catch { /* skip corrupt line */ }
    }
  } catch { /* non-fatal */ }

  return {
    hookCallsToday,
    skillDetectionsToday,
    recordsWrittenToday,
    writeSuccessRate:
      writesAttempted > 0
        ? Math.round((recordsWrittenToday / writesAttempted) * 100)
        : 100,
    lastWriteTs,
    hasData: hookCallsToday > 0,
    latency: {
      requestsToday,
      avgDurationMs: requestsToday > 0 ? Math.round(totalDurationMs / requestsToday) : 0,
      maxDurationMs,
      slowCallsToday,
      hasData: requestsToday > 0,
    },
  };
}

export function formatHookHealthHtml(summary: HookHealthSummary): string {
  if (!summary.hasData) {
    return `<p class="note">No hook health data yet — populates when skill hooks fire today.</p>`;
  }
  const lastWrite = summary.lastWriteTs
    ? new Date(summary.lastWriteTs).toLocaleTimeString()
    : "—";
  const rateClass =
    summary.writeSuccessRate >= 95 ? "roi-high" : summary.writeSuccessRate >= 70 ? "" : "roi-low";
  const latencyPills = summary.latency.hasData
    ? `
  <div class="stat-pill"><b>Avg hook latency</b><span class="val">${summary.latency.avgDurationMs}ms</span></div>
  <div class="stat-pill"><b>Slowest today</b><span class="val ${summary.latency.maxDurationMs >= SLOW_HOOK_MS ? "roi-low" : ""}">${summary.latency.maxDurationMs}ms</span></div>
  <div class="stat-pill"><b>Slow calls (≥${SLOW_HOOK_MS}ms)</b><span class="val ${summary.latency.slowCallsToday > 0 ? "roi-low" : "roi-high"}">${summary.latency.slowCallsToday}</span></div>`
    : "";
  return `<div class="stat-grid">
  <div class="stat-pill"><b>Hook calls</b><span class="val">${summary.hookCallsToday}</span></div>
  <div class="stat-pill"><b>Skill detected</b><span class="val">${summary.skillDetectionsToday}</span></div>
  <div class="stat-pill"><b>Runs written</b><span class="val">${summary.recordsWrittenToday}</span></div>
  <div class="stat-pill"><b>Write rate</b><span class="val ${rateClass}">${summary.writeSuccessRate}%</span></div>
  <div class="stat-pill"><b>Last write</b><span class="val">${lastWrite}</span></div>${latencyPills}
</div>`;
}
