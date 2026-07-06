/**
 * Background Audit Scheduler
 * 
 * Manages scheduled audit execution, runs on:
 * - Extension activation
 * - Daily at midnight (configurable)
 * - Manual trigger from UI
 * 
 * Stores audit history in .claude/learning/auditHistory.jsonl
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { AuditExecutor, AuditResult, getAuditExecutor } from "./auditExecution";

interface AuditHistoryEntry {
  timestamp: string;
  duration_ms: number;
  overallStatus: "pass" | "warn" | "fail";
  failedChecks: number;
  exportScheduled: boolean;
}

export class BackgroundAuditScheduler {
  private auditExecutor: AuditExecutor;
  private workspacePath: string;
  private scheduledCheckTimer: NodeJS.Timeout | null = null;
  private lastAuditTime: number = 0;
  private readonly MIN_AUDIT_INTERVAL_MS = 5 * 60 * 1000; // Don't run audits more than every 5 minutes
  private readonly DAILY_AUDIT_HOUR = 0; // Midnight UTC

  constructor(auditExecutor: AuditExecutor, workspacePath: string) {
    this.auditExecutor = auditExecutor;
    this.workspacePath = workspacePath;
  }

  /**
   * Initialize scheduler — call on extension activation
   */
  async initialize(): Promise<void> {
    // 1. Run immediate audit on startup (non-blocking)
    this.queueAudit("startup");

    // 2. Schedule daily audit checks
    this.scheduleDailyCheck();
  }

  /**
   * Run an audit with deduplication (prevent hammering)
   */
  private async queueAudit(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastAuditTime < this.MIN_AUDIT_INTERVAL_MS) {
      console.log(`[Audit] Skipping ${reason} — audited ${Math.round((now - this.lastAuditTime) / 1000)}s ago`);
      return;
    }

    this.lastAuditTime = now;
    console.log(`[Audit] Starting audit (${reason})`);

    const start = Date.now();
    const result = await this.auditExecutor.executeAudit();
    const duration = Date.now() - start;

    if (result) {
      await this.recordAuditHistory(result, duration, reason);
      this.notifyAuditComplete(result);
    }
  }

  /**
   * Schedule daily audit check
   */
  private scheduleDailyCheck(): void {
    // Calculate time until next midnight UTC
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(this.DAILY_AUDIT_HOUR, 0, 0, 0);

    // If midnight has already passed today, schedule for tomorrow
    if (nextMidnight <= now) {
      nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    }

    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    console.log(`[Audit] Next daily audit scheduled in ${Math.round(msUntilMidnight / 1000)}s at ${nextMidnight.toISOString()}`);

    // Schedule first audit
    this.scheduledCheckTimer = setTimeout(() => {
      this.queueAudit("daily-schedule");

      // Then schedule recurring daily audits
      setInterval(() => {
        this.queueAudit("daily-schedule");
      }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
  }

  /**
   * Record audit result to history
   */
  private async recordAuditHistory(result: AuditResult, duration: number, reason: string): Promise<void> {
    try {
      const historyFile = path.join(this.workspacePath, ".claude", "learning", "auditHistory.jsonl");

      // Ensure directory exists
      const dir = path.dirname(historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const entry: AuditHistoryEntry = {
        timestamp: result.timestamp,
        duration_ms: duration,
        overallStatus: result.overallStatus,
        failedChecks: result.compliance.filter(c => !c.ok).length,
        exportScheduled: result.scheduling.exportScheduled,
      };

      const line = JSON.stringify({ reason, ...entry, timestamp: new Date().toISOString() });
      fs.appendFileSync(historyFile, line + "\n");

      console.log(`[Audit] History recorded: ${result.overallStatus} (${duration}ms, ${entry.failedChecks} failed checks)`);
    } catch (error) {
      console.error("[Audit] Failed to record history:", error);
    }
  }

  /**
   * Notify user of audit completion (via status bar or notification)
   */
  private notifyAuditComplete(result: AuditResult): void {
    const failedCount = result.compliance.filter(c => !c.ok).length;

    if (result.overallStatus === "pass") {
      console.log(`[Audit] ✓ All compliance checks passed`);
    } else if (result.overallStatus === "warn") {
      vscode.window.showWarningMessage(`Audit complete: ${failedCount} compliance check(s) failed`, "View Report");
    } else {
      vscode.window.showErrorMessage(`Audit complete: ${failedCount} compliance check(s) failed`, "View Report");
    }
  }

  /**
   * Manually trigger audit (e.g., from UI button click)
   */
  async triggerManualAudit(): Promise<AuditResult | null> {
    await this.queueAudit("manual-trigger");
    return this.auditExecutor.getLatestAudit();
  }

  /**
   * Get audit history summary (last N entries)
   */
  async getAuditHistory(limit: number = 10): Promise<AuditHistoryEntry[]> {
    try {
      const historyFile = path.join(this.workspacePath, ".claude", "learning", "auditHistory.jsonl");

      if (!fs.existsSync(historyFile)) {
        return [];
      }

      const lines = fs.readFileSync(historyFile, "utf-8").split("\n").filter(Boolean);
      const entries = lines
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditHistoryEntry => e !== null)
        .slice(-limit);

      return entries;
    } catch (error) {
      console.error("[Audit] Failed to read history:", error);
      return [];
    }
  }

  /**
   * Cleanup on extension deactivation
   */
  dispose(): void {
    if (this.scheduledCheckTimer) {
      clearTimeout(this.scheduledCheckTimer);
      this.scheduledCheckTimer = null;
    }
  }
}

/**
 * Global scheduler instance
 */
let auditScheduler: BackgroundAuditScheduler | null = null;

export function initializeAuditScheduler(auditExecutor: AuditExecutor, workspacePath: string): BackgroundAuditScheduler {
  auditScheduler = new BackgroundAuditScheduler(auditExecutor, workspacePath);
  auditScheduler.initialize();
  return auditScheduler;
}

export function getAuditScheduler(): BackgroundAuditScheduler {
  if (!auditScheduler) {
    throw new Error("Audit scheduler not initialized. Call initializeAuditScheduler() first.");
  }
  return auditScheduler;
}
