import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTeamEconomicsCacheFingerprint,
  getOrComputeTeamEconomicsBundle,
  invalidateTeamEconomicsCache,
  teamEconomicsCachePath,
  tryReadValidTeamEconomicsCache,
  workspaceSkillsHash,
} from "./teamEconomicsCache";
import { loadManifest } from "./skillOps";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-eco-cache-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, ".claude", "learning"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "skills", "demo-skill"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "skills", "demo-skill", "SKILL.md"), "# Demo\n", "utf-8");
  fs.writeFileSync(path.join(root, ".claude", "learning", "runs.jsonl"), "", "utf-8");
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    invalidateTeamEconomicsCache(ws);
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("teamEconomicsCache", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");
  const manifest = loadManifest(libraryDir);
  const attribution = {
    "demo-skill": { claude: { cost: 1.5, tokens: 200, sessions: 2 } },
  };

  it("writes and reads disk cache when fingerprint matches", () => {
    const target = makeWorkspace();
    const fp = buildTeamEconomicsCacheFingerprint(target);
    expect(fp.skillsHash).toBe(workspaceSkillsHash(target));

    const first = getOrComputeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
    expect(fs.existsSync(teamEconomicsCachePath(target))).toBe(true);

    const hit = tryReadValidTeamEconomicsCache(target);
    expect(hit?.skillAuthors.length).toBe(first.skillAuthors.length);
    expect(hit?.teamEconomics.skillCount).toBe(first.teamEconomics.skillCount);
  });

  it("recomputes when skills directory changes", () => {
    const target = makeWorkspace();
    getOrComputeTeamEconomicsBundle(target, libraryDir, manifest, attribution);
    fs.writeFileSync(path.join(target, ".claude", "skills", "demo-skill", "SKILL.md"), "# Demo v2\n", "utf-8");
    expect(tryReadValidTeamEconomicsCache(target)).toBeUndefined();
  });
});
