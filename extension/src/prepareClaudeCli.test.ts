import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { installGitBranchSyncHook, isGitBranchSyncHookInstalled } from "./prepareClaudeCli";

function makeGitWorkspace(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-cli-"));
  execSync("git init -b main", { cwd: target, stdio: "ignore" });
  execSync('git config user.email "t@example.com"', { cwd: target, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: target, stdio: "ignore" });
  fs.writeFileSync(path.join(target, "README.md"), "# x\n");
  execSync("git add README.md", { cwd: target, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: target, stdio: "ignore" });
  fs.mkdirSync(path.join(target, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(target, ".claude", "hooks", "branch-sync.js"), "// stub\n");
  return target;
}

describe("prepareClaudeCli git hook", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("installs post-checkout hook with branch-sync marker", () => {
    const target = makeGitWorkspace();
    dirs.push(target);
    expect(installGitBranchSyncHook(target)).toBe(true);
    expect(isGitBranchSyncHookInstalled(target)).toBe(true);
    const hook = fs.readFileSync(path.join(target, ".git", "hooks", "post-checkout"), "utf-8");
    expect(hook).toContain("claude-skills branch-sync");
    expect(hook).toContain("branch-sync.js");
  });

  it("is idempotent when hook already contains marker", () => {
    const target = makeGitWorkspace();
    dirs.push(target);
    installGitBranchSyncHook(target);
    expect(installGitBranchSyncHook(target)).toBe(false);
  });
});
