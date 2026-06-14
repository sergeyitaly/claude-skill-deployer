import { describe, expect, it } from "vitest";
import { isNewerVersion, parseVersionParts } from "./extensionAutoUpdate";

describe("extensionAutoUpdate", () => {
  it("parses dotted versions", () => {
    expect(parseVersionParts("1.0.43")).toEqual([1, 0, 43]);
    expect(parseVersionParts("v2.10.1")).toEqual([2, 10, 1]);
  });

  it("detects newer semver", () => {
    expect(isNewerVersion("1.0.44", "1.0.43")).toBe(true);
    expect(isNewerVersion("1.0.43", "1.0.43")).toBe(false);
    expect(isNewerVersion("1.0.42", "1.0.43")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
  });
});
