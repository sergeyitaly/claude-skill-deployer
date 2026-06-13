import { describe, expect, it } from "vitest";
import { lintSkillMd, parseSkillFrontmatter } from "./skillLint";

const VALID = `---
name: ci-pipeline-debug
description: Debug CI pipeline failures locally and in CI.
---

# CI pipeline debug

Use when a pipeline stage fails.
`;

describe("lintSkillMd", () => {
  it("accepts valid skill", () => {
    const r = lintSkillMd("ci-pipeline-debug", VALID);
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("errors on missing description", () => {
    const raw = `---
name: bad-skill
---

# Body
`;
    const r = lintSkillMd("bad-skill", raw);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "missing-description")).toBe(true);
  });

  it("errors when frontmatter name mismatches folder", () => {
    const r = lintSkillMd("real-name", VALID);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "name-mismatch")).toBe(true);
  });

  it("parses CRLF frontmatter with long single-line description", () => {
    const raw =
      "---\r\n" +
      "name: algorithmic-art\r\n" +
      "description: Creating algorithmic art using p5.js with seeded randomness.\r\n" +
      "license: Complete terms in LICENSE.txt\r\n" +
      "---\r\n\r\n# Body\r\n";
    const fm = parseSkillFrontmatter(raw);
    expect(fm?.name).toBe("algorithmic-art");
    expect(fm?.description).toContain("p5.js");
    const r = lintSkillMd("algorithmic-art", raw);
    expect(r.issues.some((i) => i.code === "missing-description")).toBe(false);
    expect(r.issues.some((i) => i.code === "missing-fm-name")).toBe(false);
  });

  it("parses multiline block-scalar description", () => {
    const raw = `---
name: claude-api
description: |-
  Reference for the Claude API / Anthropic SDK.
  TRIGGER — read BEFORE opening the target file.
license: Complete terms in LICENSE.txt
---

# Body
`;
    const fm = parseSkillFrontmatter(raw);
    expect(fm?.description).toContain("Reference for the Claude API");
    expect(fm?.description).toContain("TRIGGER");
    const r = lintSkillMd("claude-api", raw);
    expect(r.issues.some((i) => i.code === "missing-description")).toBe(false);
  });
});
