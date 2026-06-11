#!/usr/bin/env node
/** Smoke test for branch profile git detection (no vscode required). */
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

const workspace = process.argv[2] ?? process.cwd();

function gitCommand(root, args) {
  try {
    return execSync(`git -C "${root}" ${args}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const root = gitCommand(path.resolve(workspace), "rev-parse --show-toplevel");
if (!root) {
  console.error("FAIL: not a git workspace");
  process.exit(1);
}
const branch = gitCommand(root, "rev-parse --abbrev-ref HEAD");
const origin = gitCommand(root, "config --get remote.origin.url");
const basis = origin ?? path.normalize(root);
const repoKey = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);

console.log(JSON.stringify({ workspace, root, branch, origin, repoKey }, null, 2));
