/**
 * Audit Export Scheduler
 * 
 * Manages scheduled exports of audit reports for compliance:
 * - Daily/weekly/monthly audit snapshots
 * - Export to local archive (.claude/audit-exports/)
 * - Optional integration with external compliance systems
 * 
 * Exported audits include full validation results + compliance checklist
 */

import * as fs from "fs";
import * as path from "path";
import { AuditResult } from "./auditExecution";

export type ExportFrequency = "daily" | "weekly" | "monthly" | "never";

export interface ExportSchedule {
  /** Export frequency (daily/weekly/monthly) */
  frequency: ExportFrequency;
  /** Next scheduled export timestamp */
  nextExportAt?: string;
  /** Target directory for exports */
  exportPath?: string;
  /** Whether to retain full audit details or summary only */
  summaryOnly?: boolean;
}

export interface ExportManifest {
  /** Audit export timestamp */
  timestamp: string;
  /** Overall compliance status (pass/warn/fail) */
  status: "pass" | "warn" | "fail";
  /** Number of compliance checks passed */
  checksPassed: number;
  /** Number of compliance checks failed */
  checksFailed: number;
  /** Full audit result (optional, if not summary-only) */
  fullAudit?: AuditResult;
}

/**
 * Read export schedule from .claude/audit-export-schedule.json
 */
export function readExportSchedule(workspacePath: string): ExportSchedule | null {
  try {
    const scheduleFile = path.join(workspacePath, ".claude", "audit-export-schedule.json");

    if (!fs.existsSync(scheduleFile)) {
      return null; // Not configured
    }

    return JSON.parse(fs.readFileSync(scheduleFile, "utf-8"));
  } catch (error) {
    console.error("[ExportScheduler] Failed to read schedule:", error);
    return null;
  }
}

/**
 * Configure export schedule
 */
export function configureExportSchedule(
  workspacePath: string,
  frequency: ExportFrequency,
  exportPath?: string
): boolean {
  try {
    const scheduleDir = path.join(workspacePath, ".claude");
    if (!fs.existsSync(scheduleDir)) {
      fs.mkdirSync(scheduleDir, { recursive: true });
    }

    const schedule: ExportSchedule = {
      frequency,
      exportPath: exportPath || path.join(workspacePath, ".claude", "audit-exports"),
      nextExportAt: calculateNextExportTime(frequency).toISOString(),
      summaryOnly: false,
    };

    const scheduleFile = path.join(scheduleDir, "audit-export-schedule.json");
    fs.writeFileSync(scheduleFile, JSON.stringify(schedule, null, 2) + "\n");

    console.log(`[ExportScheduler] ✓ Configured ${frequency} exports to ${schedule.exportPath}`);
    return true;
  } catch (error) {
    console.error("[ExportScheduler] Failed to configure:", error);
    return false;
  }
}

/**
 * Calculate next export time based on frequency
 */
function calculateNextExportTime(frequency: ExportFrequency): Date {
  const now = new Date();

  switch (frequency) {
    case "daily":
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);
      return tomorrow;

    case "weekly":
      const nextWeek = new Date(now);
      nextWeek.setUTCDate(nextWeek.getUTCDate() + (7 - nextWeek.getUTCDay()));
      nextWeek.setUTCHours(0, 0, 0, 0);
      return nextWeek;

    case "monthly":
      const nextMonth = new Date(now);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      nextMonth.setUTCDate(1);
      nextMonth.setUTCHours(0, 0, 0, 0);
      return nextMonth;

    case "never":
    default:
      return new Date(0); // Never
  }
}

/**
 * Export audit result to archive
 */
export function exportAuditResult(
  workspacePath: string,
  auditResult: AuditResult,
  scheduleConfig?: ExportSchedule
): string | null {
  try {
    const schedule = scheduleConfig || readExportSchedule(workspacePath);
    if (!schedule || schedule.frequency === "never") {
      return null; // Export not scheduled
    }

    const exportDir = schedule.exportPath || path.join(workspacePath, ".claude", "audit-exports");

    // Create export directory if it doesn't exist
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    // Generate filename: audit-2026-01-15-12-30-45.json
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, "-").split("T")[0];
    const timeStr = now.toISOString().split("T")[1].replace(/[:.]/g, "-").split("Z")[0];
    const filename = `audit-${dateStr}-${timeStr}.json`;
    const exportPath = path.join(exportDir, filename);

    // Build export manifest
    const manifest: ExportManifest = {
      timestamp: auditResult.timestamp,
      status: auditResult.overallStatus,
      checksPassed: auditResult.compliance.filter(c => c.ok).length,
      checksFailed: auditResult.compliance.filter(c => !c.ok).length,
    };

    if (!schedule.summaryOnly) {
      manifest.fullAudit = auditResult;
    }

    // Write export
    fs.writeFileSync(exportPath, JSON.stringify(manifest, null, 2) + "\n");

    console.log(`[ExportScheduler] ✓ Exported audit to ${exportPath}`);
    return exportPath;
  } catch (error) {
    console.error("[ExportScheduler] Failed to export audit:", error);
    return null;
  }
}

/**
 * List exported audit files
 */
export function listExportedAudits(workspacePath: string): ExportManifest[] {
  try {
    const exportDir = path.join(workspacePath, ".claude", "audit-exports");

    if (!fs.existsSync(exportDir)) {
      return [];
    }

    const files = fs.readdirSync(exportDir)
      .filter(f => f.startsWith("audit-") && f.endsWith(".json"))
      .sort()
      .reverse(); // Newest first

    return files
      .slice(0, 30) // Last 30 exports
      .map(file => {
        try {
          return JSON.parse(fs.readFileSync(path.join(exportDir, file), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter((m): m is ExportManifest => m !== null);
  } catch (error) {
    console.error("[ExportScheduler] Failed to list exports:", error);
    return [];
  }
}

/**
 * Get export history summary (pass rates over time)
 */
export function getExportHistorySummary(workspacePath: string): {
  totalExports: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  complianceTrend: ("improving" | "stable" | "declining");
} {
  const exports = listExportedAudits(workspacePath);

  const passCount = exports.filter(e => e.status === "pass").length;
  const warnCount = exports.filter(e => e.status === "warn").length;
  const failCount = exports.filter(e => e.status === "fail").length;

  // Determine trend: compare last 10 to previous 10
  let trend: "improving" | "stable" | "declining" = "stable";
  if (exports.length >= 10) {
    const recent = exports.slice(0, 5);
    const older = exports.slice(5, 10);

    const recentPassRate = recent.filter(e => e.status === "pass").length / recent.length;
    const olderPassRate = older.filter(e => e.status === "pass").length / older.length;

    if (recentPassRate > olderPassRate + 0.1) {
      trend = "improving";
    } else if (recentPassRate < olderPassRate - 0.1) {
      trend = "declining";
    }
  }

  return {
    totalExports: exports.length,
    passCount,
    warnCount,
    failCount,
    complianceTrend: trend,
  };
}

/**
 * Get export schedule status
 */
export function getExportScheduleStatus(workspacePath: string): {
  configured: boolean;
  frequency?: ExportFrequency;
  nextExportAt?: string;
  isOverdue: boolean;
} {
  const schedule = readExportSchedule(workspacePath);

  if (!schedule) {
    return {
      configured: false,
      isOverdue: false,
    };
  }

  const nextExport = schedule.nextExportAt ? new Date(schedule.nextExportAt) : null;
  const isOverdue = nextExport ? nextExport < new Date() : false;

  return {
    configured: true,
    frequency: schedule.frequency,
    nextExportAt: nextExport?.toISOString(),
    isOverdue,
  };
}
