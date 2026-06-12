import { describe, expect, it } from "vitest";
import { CURSOR_TRANSCRIPT_MODEL, formatModelLabel } from "./usageCost";

describe("formatModelLabel", () => {
  it("labels cursor transcript estimate", () => {
    expect(formatModelLabel(CURSOR_TRANSCRIPT_MODEL)).toContain("Cursor");
  });

  it("passes through claude model ids", () => {
    expect(formatModelLabel("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-20250514");
  });
});
