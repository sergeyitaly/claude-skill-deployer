import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setPricingContext, pricingForModel } from "./costRates";
import { writePricingOverrides } from "./pricingOverrides";

const workspaces: string[] = [];

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-"));
  workspaces.push(ws);
  fs.mkdirSync(path.join(ws, ".claude", "learning"), { recursive: true });
  return ws;
}

afterEach(() => {
  setPricingContext(undefined);
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("pricingOverrides", () => {
  it("applies workspace model pricing overrides", () => {
    const target = makeWorkspace();
    writePricingOverrides(target, {
      version: 1,
      models: {
        opus: { input: 10, output: 50, cacheWrite: 12, cacheRead: 1 },
      },
    });
    setPricingContext(target);
    const p = pricingForModel("claude-opus-4");
    expect(p.input).toBe(10);
    expect(p.output).toBe(50);
  });
});
