import { describe, expect, it } from "vitest";
import { parseActiveSkills } from "./transcriptParsers";

describe("parseActiveSkills", () => {
  it("ignores skill_listing catalog lines", () => {
    const content = [
      '{"type":"skill_listing","skills":["terraform-plan-review","ci-pipeline-debug"]}',
      '{"tool_use":{"name":"Read","input":{"file_path":"/proj/.claude/skills/terraform-plan-review/SKILL.md"}}}',
    ].join("\n");
    const skills = parseActiveSkills(content);
    expect(skills).toEqual(["terraform-plan-review"]);
  });

  it("detects Skill tool skill_name", () => {
    const content = '{"tool_use":{"name":"Skill","input":{"skill_name":"adx-schema-check"}}}';
    expect(parseActiveSkills(content)).toContain("adx-schema-check");
  });

  it("detects explicit SKILL markers", () => {
    expect(parseActiveSkills("loading [SKILL:ci-pipeline-debug] now")).toEqual(["ci-pipeline-debug"]);
  });

  it("denylists bogus names", () => {
    expect(parseActiveSkills('"skill_name": "api"')).toEqual([]);
    expect(parseActiveSkills('"skill_name": "claude-api"')).toEqual([]);
  });
});
