import { describe, expect, it } from "vitest";
import { detectEqualSplitCluster, resolveDisplayAttribution } from "./costAttribution";

describe("detectEqualSplitCluster", () => {
  it("flags three skills with identical cost", () => {
    const map = {
      a: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
      b: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
      c: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
    };
    expect(detectEqualSplitCluster(map)?.count).toBe(3);
  });

  it("returns null for varied costs", () => {
    const map = {
      a: { claude: { tokens: 100, cost: 1.2, sessions: 1 } },
      b: { claude: { tokens: 100, cost: 3.4, sessions: 1 } },
    };
    expect(detectEqualSplitCluster(map)).toBeNull();
  });
});

describe("resolveDisplayAttribution", () => {
  it("hides transcript merge when equal-split detected", () => {
    const built = {
      skills: { real: { claude: { tokens: 10, cost: 0.5, sessions: 1 } } },
      transcriptSkills: {
        fake1: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
        fake2: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
        fake3: { claude: { tokens: 100, cost: 579.51, sessions: 1 } },
      },
    };
    const { staleEqualSplit, attribution } = resolveDisplayAttribution(built);
    expect(staleEqualSplit).toBe(true);
    expect(Object.keys(attribution)).toContain("real");
    expect(Object.keys(attribution)).not.toContain("fake1");
  });
});
