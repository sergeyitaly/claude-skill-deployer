import { describe, expect, it } from "vitest";
import { localDateKey } from "./localDate";

describe("localDateKey", () => {
  it("formats local calendar date as YYYY-MM-DD", () => {
    expect(localDateKey(new Date(2026, 5, 11, 23, 59, 59))).toBe("2026-06-11");
  });

  it("pads single-digit month and day", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("uses local calendar components from Date getters", () => {
    const local = new Date(2026, 5, 11, 23, 30, 0);
    expect(localDateKey(local)).toBe("2026-06-11");
  });
});
