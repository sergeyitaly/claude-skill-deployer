import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCostDashboardHtml } from "./costDashboard";

const workspaces: string[] = [];

function makeWorkspace(libraryDir: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost-dash-"));
  workspaces.push(root);
  fs.mkdirSync(path.join(root, ".claude", "learning"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "learning", "runs.jsonl"), "", "utf-8");
  return root;
}

afterEach(() => {
  for (const ws of workspaces) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  workspaces.length = 0;
});

describe("formatCostDashboardHtml", () => {
  const libraryDir = path.join(__dirname, "..", "skills_library");

  it("uses nonce script listeners instead of inline onclick (CSP-safe)", () => {
    const target = makeWorkspace(libraryDir);
    const nonce = "test-nonce-abc";
    const html = formatCostDashboardHtml(target, libraryDir, nonce);
    expect(html).not.toMatch(/onclick=/);
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain("rebindDashboardActionListeners");
    expect(html).toContain("btn-apply-opts");
    expect(html).toContain("acquireVsCodeApi");
  });
});
