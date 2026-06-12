#!/usr/bin/env node
// Claude Code SessionStart hook: cheap check for anthropics/skills updates and
// inject context so Claude runs skill-official-updater when candidates exist.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const OFFICIAL_REPO = "https://github.com/anthropics/skills.git";
const OFFICIAL_API = "https://api.github.com/repos/anthropics/skills/contents/skills";
const SESSION_SOURCES = new Set(["startup", "resume", "clear"]);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function resolveLibraryDir(cwd) {
  const libraryDir = path.join(cwd, "skills_library");
  if (fs.existsSync(path.join(libraryDir, "manifest.json"))) {
    return libraryDir;
  }
  return null;
}

function fetchRemoteHeadSha() {
  try {
    const out = execFileSync("git", ["ls-remote", OFFICIAL_REPO, "HEAD"], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((l) => l.trim().length > 0);
    return line ? line.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

function listLocalSkillNames(libraryDir) {
  const names = new Set();
  let entries;
  try {
    entries = fs.readdirSync(libraryDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && fs.existsSync(path.join(libraryDir, entry.name, "SKILL.md"))) {
      names.add(entry.name);
    }
  }
  return names;
}

function classifyCandidates(libraryDir, upstreamNames, state) {
  const local = listLocalSkillNames(libraryDir);
  const managed = (state && state.skills) || {};
  const candidates = [];
  for (const name of upstreamNames) {
    if (!local.has(name)) {
      candidates.push({ name, kind: "new" });
    } else if (managed[name]) {
      candidates.push({ name, kind: "updated" });
    } else {
      candidates.push({ name, kind: "collision" });
    }
  }
  return candidates;
}

function fetchUpstreamSkillNames() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      OFFICIAL_API,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "claude-skills-deployer" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve(
              parsed
                .filter((e) => e.type === "dir" && e.name)
                .map((e) => e.name)
                .sort()
            );
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error("GitHub API timeout"));
    });
  });
}

function formatContext(result) {
  if (result.checkError) {
    return `[Claude Skills] Official skill update check failed: ${result.checkError}`;
  }
  if (result.unchanged) {
    return "";
  }
  const newSkills = result.candidates.filter((c) => c.kind === "new").map((c) => c.name);
  const updated = result.candidates.filter((c) => c.kind === "updated").map((c) => c.name);
  const collisions = result.candidates.filter((c) => c.kind === "collision").map((c) => c.name);
  const parts = [
    "[Claude Skills] anthropics/skills has updates.",
    `Remote HEAD: ${(result.remoteSha || "unknown").slice(0, 12)}`,
  ];
  if (result.previousSha) {
    parts.push(`Last synced: ${result.previousSha.slice(0, 12)}`);
  } else {
    parts.push("No local sync state yet (.official-skills-state.json missing or empty).");
  }
  if (newSkills.length) {
    parts.push(`New upstream skills (${newSkills.length}): ${newSkills.join(", ")}.`);
  }
  if (updated.length) {
    parts.push(`Managed skills with upstream changes (${updated.length}): ${updated.join(", ")}.`);
  }
  if (collisions.length) {
    parts.push(`Name collisions (local custom, not auto-touched): ${collisions.join(", ")}.`);
  }
  parts.push(
    "Read and follow the skill-official-updater skill now: automatically pull every new and managed-updated skill (no user prompt). Skip name-collision skills only."
  );
  return parts.join(" ");
}

async function runCheck(cwd) {
  const libraryDir = resolveLibraryDir(cwd);
  if (!libraryDir) {
    return null;
  }

  const statePath = path.join(libraryDir, ".official-skills-state.json");
  const state = readJsonSafe(statePath);
  const previousSha = (state && state.repoSha) || null;
  const remoteSha = fetchRemoteHeadSha();
  if (!remoteSha) {
    return { unchanged: true, checkError: "git ls-remote failed" };
  }
  if (previousSha && previousSha === remoteSha) {
    return { unchanged: true, remoteSha, previousSha, candidates: [] };
  }

  try {
    const upstreamNames = await fetchUpstreamSkillNames();
    const candidates = classifyCandidates(libraryDir, upstreamNames, state);
    const actionable = candidates.filter((c) => c.kind === "new" || c.kind === "updated");
    return {
      unchanged: actionable.length === 0 && previousSha !== null,
      remoteSha,
      previousSha,
      candidates,
    };
  } catch (err) {
    return { unchanged: true, checkError: err.message, remoteSha, previousSha, candidates: [] };
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    return;
  }

  const cwd = input.cwd;
  const source = input.source || "startup";
  if (!cwd || !SESSION_SOURCES.has(source)) {
    return;
  }

  const result = await runCheck(cwd);
  if (!result) {
    return;
  }

  const context = formatContext(result);
  if (!context) {
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })
  );
}

main().catch(() => {
  // non-fatal
});
