import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface HealthMetrics {
  activationCount: number;
  averageSessionDuration: number;
  featureUsage: Record<string, number>;
  errorRate: number;
  averageOptimizationSavings: number;
  lastActivation?: string;
}

const METRICS_PATH = path.join(os.homedir(), ".claude", "learning", "health-metrics.json");

function readMetrics(): HealthMetrics {
  if (!fs.existsSync(METRICS_PATH)) {
    return {
      activationCount: 0,
      averageSessionDuration: 0,
      featureUsage: {},
      errorRate: 0,
      averageOptimizationSavings: 0,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(METRICS_PATH, "utf-8")) as HealthMetrics;
  } catch {
    return {
      activationCount: 0,
      averageSessionDuration: 0,
      featureUsage: {},
      errorRate: 0,
      averageOptimizationSavings: 0,
    };
  }
}

function writeMetrics(metrics: HealthMetrics): void {
  fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
  fs.writeFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2) + "\n", "utf-8");
}

export function isTelemetryEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills.telemetry").get<boolean>("enabled", false);
}

export function recordActivation(): void {
  if (!isTelemetryEnabled()) {
    return;
  }
  const m = readMetrics();
  m.activationCount += 1;
  m.lastActivation = new Date().toISOString();
  writeMetrics(m);
}

export function recordFeatureUse(feature: string): void {
  if (!isTelemetryEnabled()) {
    return;
  }
  const m = readMetrics();
  m.featureUsage[feature] = (m.featureUsage[feature] ?? 0) + 1;
  writeMetrics(m);
}

export function recordError(): void {
  if (!isTelemetryEnabled()) {
    return;
  }
  const m = readMetrics();
  const total = m.activationCount || 1;
  m.errorRate = Math.min(1, m.errorRate + 1 / total);
  writeMetrics(m);
}

export function getHealthMetrics(): HealthMetrics {
  return readMetrics();
}
