import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { isFeatureEnabled } from "./featureFlags";
import { SkillAttributionMap } from "./costAttribution";

export interface SkillBenchmark {
  skill: string;
  your_avg_cost: number;
  community_avg: number;
  percentile: number;
  tips: string[];
  updatedAt: string;
}

export interface BenchmarksStore {
  version: 1;
  optIn: boolean;
  lastSync?: string;
  skills: Record<string, SkillBenchmark>;
}

export const BENCHMARKS_PATH = path.join(os.homedir(), ".claude", "learning", "community-benchmarks.json");

const DEFAULT_TIPS: Record<string, string[]> = {
  "terraform-plan-review": ["Use --target flag to scope plan", "Cache plan outputs for repeated reviews"],
  "azure-rbac-diagnostics": ["Paste exact AuthorizationFailed error before invoking", "Scope to one resource group"],
  "adx-schema-check": ["Diff against committed schema only", "Skip live cluster unless debugging prod"],
};

const SEED_COMMUNITY_AVG: Record<string, number> = {
  "terraform-plan-review": 0.18,
  "azure-rbac-diagnostics": 0.12,
  "adx-schema-check": 0.14,
  "ci-pipeline-debug": 0.16,
  "terraform-module-ops": 0.2,
};

function readStore(): BenchmarksStore {
  if (!fs.existsSync(BENCHMARKS_PATH)) {
    return { version: 1, optIn: false, skills: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(BENCHMARKS_PATH, "utf-8")) as BenchmarksStore;
  } catch {
    return { version: 1, optIn: false, skills: {} };
  }
}

function writeStore(store: BenchmarksStore): void {
  fs.mkdirSync(path.dirname(BENCHMARKS_PATH), { recursive: true });
  fs.writeFileSync(BENCHMARKS_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function percentile(yours: number, community: number): number {
  if (community <= 0) {
    return 50;
  }
  const ratio = yours / community;
  if (ratio <= 0.8) {
    return 25;
  }
  if (ratio <= 1.0) {
    return 45;
  }
  if (ratio <= 1.25) {
    return 65;
  }
  return 85;
}

export function updateLocalBenchmarks(attribution: SkillAttributionMap): BenchmarksStore {
  if (!isFeatureEnabled("communityBenchmarks")) {
    return readStore();
  }
  const store = readStore();
  const cfg = vscode.workspace.getConfiguration("claudeSkills.benchmarks");
  store.optIn = cfg.get<boolean>("optIn", false);

  for (const [skill, agents] of Object.entries(attribution)) {
    const sessions = Object.values(agents).reduce((s, a) => s + (a?.sessions ?? 0), 0);
    const cost = Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0);
    if (sessions === 0) {
      continue;
    }
    const yourAvg = cost / sessions;
    const communityAvg = store.skills[skill]?.community_avg ?? SEED_COMMUNITY_AVG[skill] ?? yourAvg * 0.85;
    store.skills[skill] = {
      skill,
      your_avg_cost: Math.round(yourAvg * 1000) / 1000,
      community_avg: communityAvg,
      percentile: percentile(yourAvg, communityAvg),
      tips: store.skills[skill]?.tips ?? DEFAULT_TIPS[skill] ?? ["Use /compact before heavy analysis"],
      updatedAt: new Date().toISOString(),
    };
  }
  writeStore(store);
  return store;
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

export async function syncCommunityBenchmarks(): Promise<number> {
  if (!isFeatureEnabled("communityBenchmarks")) {
    return 0;
  }
  const cfg = vscode.workspace.getConfiguration("claudeSkills.benchmarks");
  const url = cfg.get<string>("downloadUrl", "");
  if (!url) {
    return 0;
  }
  try {
    const raw = await fetchUrl(url);
    const remote = JSON.parse(raw) as { skills?: Record<string, { community_avg?: number; tips?: string[] }> };
    const store = readStore();
    for (const [skill, row] of Object.entries(remote.skills ?? {})) {
      const existing = store.skills[skill];
      if (!existing) {
        continue;
      }
      if (row.community_avg) {
        existing.community_avg = row.community_avg;
        existing.percentile = percentile(existing.your_avg_cost, row.community_avg);
      }
      if (row.tips?.length) {
        existing.tips = row.tips;
      }
    }
    store.lastSync = new Date().toISOString();
    writeStore(store);
    return Object.keys(remote.skills ?? {}).length;
  } catch {
    return 0;
  }
}

export async function uploadAnonymizedStats(attribution: SkillAttributionMap): Promise<boolean> {
  if (!isFeatureEnabled("communityBenchmarks")) {
    return false;
  }
  const cfg = vscode.workspace.getConfiguration("claudeSkills.benchmarks");
  if (!cfg.get<boolean>("optIn", false)) {
    return false;
  }
  const url = cfg.get<string>("uploadUrl", "");
  if (!url) {
    return false;
  }
  const payload = Object.entries(attribution).map(([skill, agents]) => {
    const sessions = Object.values(agents).reduce((s, a) => s + (a?.sessions ?? 0), 0);
    const cost = Object.values(agents).reduce((s, a) => s + (a?.cost ?? 0), 0);
    return { skill, avg_cost: sessions > 0 ? cost / sessions : 0, sessions };
  });
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ ts: new Date().toISOString(), skills: payload });
      const req = https.request(
        url,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          res.on("data", () => undefined);
          res.on("end", () => resolve(res.statusCode !== undefined && res.statusCode < 400));
        }
      );
      req.on("error", () => resolve(false));
      req.write(body);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

export function formatBenchmarkLine(skill: string): string | undefined {
  const row = readStore().skills[skill];
  if (!row) {
    return undefined;
  }
  const cmp = row.percentile > 55 ? "above avg" : row.percentile < 45 ? "below avg" : "near avg";
  return `bench: $${row.your_avg_cost.toFixed(2)} vs $${row.community_avg.toFixed(2)} community (${cmp})`;
}
