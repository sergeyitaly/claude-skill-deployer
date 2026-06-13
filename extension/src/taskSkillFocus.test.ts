import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { listEffectiveEnabledSkills, readSkillOverrides } from "./skillOps";
import {
  applyTaskSkillFocus,
  readTaskActiveSkills,
  taskActiveSkillsPath,
} from "./taskSkillFocus";
import { listInstalledSkills } from "./usageStats";

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-focus-"));
  for (const name of ["pdf", "mcp-builder"]) {
    const skillDir = path.join(dir, ".claude", "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf-8");
  }
  return dir;
}

describe("applyTaskSkillFocus", () => {
  it("sets skillOverrides off for skills outside the active task set", () => {
    const target = makeWorkspace();
    const focus = applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals", "2026-06-14T00:00:00.000Z");

    expect(focus.activeSkills).toContain("pdf");
    expect(focus.ignoredSkills).toContain("mcp-builder");
    expect(readSkillOverrides(target)["mcp-builder"]).toBe("off");
    expect(readSkillOverrides(target).pdf).toBeUndefined();
    expect(listEffectiveEnabledSkills(target)).toContain("pdf");
    expect(listEffectiveEnabledSkills(target)).not.toContain("mcp-builder");

    const saved = readTaskActiveSkills(target);
    expect(saved?.activeSkills).toContain("pdf");
    expect(fs.existsSync(taskActiveSkillsPath(target))).toBe(true);
  });

  it("re-enables previously ignored skills when they join a new task set", () => {
    const target = makeWorkspace();
    applyTaskSkillFocus(target, ["pdf"], "task-skill-proposals");
    applyTaskSkillFocus(target, ["pdf", "mcp-builder"], "task-skill-proposals", "2026-06-14T01:00:00.000Z");

    expect(readSkillOverrides(target)["mcp-builder"]).toBeUndefined();
    expect(listEffectiveEnabledSkills(target)).toContain("mcp-builder");
  });
});
