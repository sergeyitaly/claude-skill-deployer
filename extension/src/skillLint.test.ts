import { describe, expect, it } from "vitest";
import { lintSkillMd } from "./skillLint";

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
});
