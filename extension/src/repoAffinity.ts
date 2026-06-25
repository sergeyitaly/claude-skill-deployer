import * as fs from "node:fs";
import * as path from "node:path";

export interface RepoAffinitySignal {
  signal: string;
  detected: boolean;
}

export interface RepoAffinityResult {
  computedAt: string;
  signals: RepoAffinitySignal[];
  skillBoosts: Record<string, number>;
}

const AFFINITY_CACHE_HOURS = 24;
const AFFINITY_REL = path.join(".claude", "learning", "repo-affinity.json");

// Cap the contribution of any single signal to this many boost points per skill.
// Prevents one signal (e.g. .kiro dir) from single-handedly pushing a skill to 30pts.
const MAX_SINGLE_SIGNAL_BOOST = 15;

// In-process session cache — avoids re-reading disk on every proposal cycle.
const _memCache = new Map<string, { result: RepoAffinityResult; mtimeMs: number }>();

// Each entry: signal id, detector fn, skill→boost-pts map
const SIGNAL_RULES: Array<{
  signal: string;
  detect: (t: string) => boolean;
  boosts: Record<string, number>;
}> = [
  {
    signal: "vscode_package_dep",
    detect: (t) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(t, "package.json"), "utf-8")) as Record<string, unknown>;
        const all = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}), ...(pkg.peerDependencies as object ?? {}) };
        return "@types/vscode" in all || (typeof (pkg.engines as Record<string,unknown> ?? {}).vscode === "string");
      } catch { return false; }
    },
    boosts: { "vscode-extension-publishing": 35, "vitest-extension-testing": 30, "cursor-kiro-extension-publishing": 20 },
  },
  {
    signal: "ts_src_dir",
    detect: (t) => {
      try {
        const src = path.join(t, "src");
        return fs.existsSync(src) && fs.readdirSync(src).filter(f => f.endsWith(".ts")).length > 15;
      } catch { return false; }
    },
    boosts: { "vitest-extension-testing": 20, "vscode-extension-publishing": 15 },
  },
  {
    signal: "github_workflows",
    detect: (t) => fs.existsSync(path.join(t, ".github", "workflows")),
    boosts: { "github-actions-ci": 25, "ci-pipeline-debug": 15, "ci-preflight": 15 },
  },
  {
    signal: "terraform_files",
    detect: (t) => {
      try { return fs.readdirSync(t).some(f => f.endsWith(".tf")); } catch { return false; }
    },
    boosts: { "terraform-plan-review": 35, "terraform-module-ops": 30, "deployment-practical": 15 },
  },
  {
    signal: "azure_pipeline",
    detect: (t) => fs.existsSync(path.join(t, ".azure")) || fs.existsSync(path.join(t, "azure-pipelines.yml")),
    boosts: { "azure-resource-ops": 30, "azure-rbac-diagnostics": 25, "azure-infra-preflight": 25 },
  },
  {
    signal: "kiro_dir",
    detect: (t) => fs.existsSync(path.join(t, ".kiro")),
    boosts: { "cursor-kiro-extension-publishing": 30, "vscode-extension-publishing": 20 },
  },
  {
    signal: "adx_kql_files",
    detect: (t) => {
      try { return fs.readdirSync(t).some(f => f.endsWith(".kql") || f.endsWith(".csl")); } catch { return false; }
    },
    boosts: { "adx-schema-check": 40 },
  },
  {
    signal: "claude_skills_project",
    detect: (t) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(t, "package.json"), "utf-8")) as Record<string, unknown>;
        const name = String(pkg.name ?? "").toLowerCase();
        return name.includes("skill") || name.includes("claude");
      } catch { return false; }
    },
    boosts: { "skill-creator": 25, "skill-usage-insights": 20, "skill-feedback-adaptation": 20, "self-learning": 15 },
  },
  {
    signal: "skills_library_dir",
    detect: (t) => fs.existsSync(path.join(t, "skills_library")),
    boosts: { "skill-creator": 20, "skill-official-updater": 20, "self-learning": 15 },
  },
  {
    signal: "python_scripts",
    detect: (t) => {
      try { return fs.readdirSync(t).some(f => f.endsWith(".py")); } catch { return false; }
    },
    boosts: { "deployment-practical": 15 },
  },
];

function computeRepoAffinity(target: string): RepoAffinityResult {
  const signals: RepoAffinitySignal[] = [];
  const boostMap: Record<string, number> = {};

  for (const rule of SIGNAL_RULES) {
    let detected = false;
    try { detected = rule.detect(target); } catch { /* non-fatal */ }
    signals.push({ signal: rule.signal, detected });
    if (detected) {
      for (const [skill, pts] of Object.entries(rule.boosts)) {
        // Cap single-signal contribution so one directory can't alone push a skill above threshold.
        const capped = Math.min(pts, MAX_SINGLE_SIGNAL_BOOST);
        boostMap[skill] = Math.min(60, (boostMap[skill] ?? 0) + capped);
      }
    }
  }

  return { computedAt: new Date().toISOString(), signals, skillBoosts: boostMap };
}

export function getOrComputeRepoAffinity(target: string): RepoAffinityResult {
  const file = path.join(target, AFFINITY_REL);
  const key = path.resolve(target);

  // 1. Check in-process memory cache — avoids disk read on every proposal cycle.
  const mem = _memCache.get(key);
  if (mem) {
    try {
      const fileMtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
      if (fileMtime === mem.mtimeMs) return mem.result;
    } catch { /* fall through */ }
  }

  // 2. Check disk cache — also invalidate if .git/HEAD changed since the cache was written
  //    (branch switch → different tech-stack signals → stale affinity boosts).
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf-8")) as RepoAffinityResult;
    const ageMs = Date.now() - new Date(cached.computedAt).getTime();
    if (ageMs < AFFINITY_CACHE_HOURS * 3_600_000 && cached.skillBoosts) {
      // Invalidate if the git HEAD has moved since the cache was computed.
      const cacheEpoch = new Date(cached.computedAt).getTime();
      let gitHeadMtime = 0;
      try { gitHeadMtime = fs.statSync(path.join(target, ".git", "HEAD")).mtimeMs; } catch { /* not a git repo */ }
      if (gitHeadMtime > cacheEpoch) {
        // Branch switched — drop cache and fall through to recompute.
        _memCache.delete(key);
      } else {
        const mtime = fs.statSync(file).mtimeMs;
        _memCache.set(key, { result: cached, mtimeMs: mtime });
        return cached;
      }
    }
  } catch { /* recompute */ }

  // 3. Recompute and persist.
  const result = computeRepoAffinity(target);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n", "utf-8");
    const mtime = fs.statSync(file).mtimeMs;
    _memCache.set(key, { result, mtimeMs: mtime });
  } catch { /* non-fatal */ }
  return result;
}

export function invalidateRepoAffinity(target: string): void {
  _memCache.delete(path.resolve(target));
  try { fs.unlinkSync(path.join(target, AFFINITY_REL)); } catch { /* missing is fine */ }
}
