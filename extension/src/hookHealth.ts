import * as fs from "node:fs";
import * as path from "node:path";

const HOOK_HEALTH_REL = path.join(".claude", "learning", "hook-health.jsonl");

export interface HookHealthRecord {
  ts: string;
  event: "hook_fired";
  skill: string | null;
  wrote_runs: boolean;
  agent: string;
  session_id?: string;
  error?: string;
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
}

export function computeHookHealthSummary(target: string): HookHealthSummary {
  const file = hookHealthPath(target);
  if (!fs.existsSync(file)) {
    return {
      hookCallsToday: 0,
      skillDetectionsToday: 0,
      recordsWrittenToday: 0,
      writeSuccessRate: 100,
      lastWriteTs: null,
      hasData: false,
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

  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as HookHealthRecord;
        if (new Date(r.ts).getTime() < cutoff) continue;
        hookCallsToday++;
        if (r.skill !== null) {
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
  return `<div class="stat-grid">
  <div class="stat-pill"><b>Hook calls</b><span class="val">${summary.hookCallsToday}</span></div>
  <div class="stat-pill"><b>Skill detected</b><span class="val">${summary.skillDetectionsToday}</span></div>
  <div class="stat-pill"><b>Runs written</b><span class="val">${summary.recordsWrittenToday}</span></div>
  <div class="stat-pill"><b>Write rate</b><span class="val ${rateClass}">${summary.writeSuccessRate}%</span></div>
  <div class="stat-pill"><b>Last write</b><span class="val">${lastWrite}</span></div>
</div>`;
}
