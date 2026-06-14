import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  attributeCostToAuthors,
  invalidateAuthorAttributionCache,
} from "./teamCostSharing";

describe("teamCostSharing blame cache", () => {
  it("returns cached authors without re-querying git when SKILL.md mtime unchanged", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blame-cache-"));
    const skillsDir = path.join(tmp, ".claude", "skills", "demo-skill");
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillFile = path.join(skillsDir, "SKILL.md");
    fs.writeFileSync(skillFile, "# Demo\n", "utf-8");

    invalidateAuthorAttributionCache(tmp);
    const first = attributeCostToAuthors(tmp, { "demo-skill": { claude: { cost: 1, tokens: 100 } } });
    const second = attributeCostToAuthors(tmp, { "demo-skill": { claude: { cost: 2, tokens: 200 } } });

    expect(first.length).toBeGreaterThan(0);
    expect(second[0]?.author).toBe(first[0]?.author);
    expect(second[0]?.monthlyCost).toBeGreaterThan(first[0]?.monthlyCost ?? 0);
  });
});
