import { describe, expect, it } from "vitest";
import { buildToolUseTokenIndex, extractToolUseIds } from "./v2TokenEnrichment";

describe("extractToolUseIds", () => {
  it("finds tool_use id in assistant content", () => {
    const node = {
      message: {
        content: [{ type: "tool_use", id: "toolu_abc123", name: "Skill", input: { skill: "ci-pipeline-debug" } }],
      },
    };
    expect(extractToolUseIds(node)).toContain("toolu_abc123");
  });
});

describe("buildToolUseTokenIndex", () => {
  it("maps tool_use_id to usage on a following line", () => {
    const content = [
      JSON.stringify({
        message: {
          content: [{ type: "tool_use", id: "toolu_skill1", name: "Skill", input: { skill: "terraform-plan-review" } }],
        },
      }),
      JSON.stringify({
        message: {
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    ].join("\n");

    const index = buildToolUseTokenIndex(content);
    expect(index.get("toolu_skill1")).toBe(1500);
  });
});
