import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditExecutor } from "./auditExecution";

function makeExecutor(): AuditExecutor & {
  checkPrivacyCompliance(runsFile: string): { compliant: boolean; issues?: string[] };
} {
  return new AuditExecutor() as unknown as AuditExecutor & {
    checkPrivacyCompliance(runsFile: string): { compliant: boolean; issues?: string[] };
  };
}

describe("AuditExecutor.checkPrivacyCompliance", () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    while (tmpFiles.length) {
      const f = tmpFiles.pop()!;
      fs.rmSync(f, { force: true });
    }
  });

  function writeRuns(lines: string[]): string {
    const file = path.join(os.tmpdir(), `runs-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(file, lines.join("\n"));
    tmpFiles.push(file);
    return file;
  }

  it("is compliant when runs.jsonl does not exist", () => {
    const result = makeExecutor().checkPrivacyCompliance(path.join(os.tmpdir(), "does-not-exist.jsonl"));
    expect(result.compliant).toBe(true);
    expect(result.issues).toBeUndefined();
  });

  it("is compliant when records only carry bounded labels/metrics", () => {
    const file = writeRuns([
      JSON.stringify({ skill: "vitest-extension-testing", action: "skill_invoke", tokens: 100 }),
      JSON.stringify({ skill: "skill-creator", action: "skill_invoke", cost: 0.01 }),
    ]);
    const result = makeExecutor().checkPrivacyCompliance(file);
    expect(result.compliant).toBe(true);
    expect(result.issues).toBeUndefined();
  });

  it("flags records with raw prompt/message text over the length threshold", () => {
    const longText = "x".repeat(250);
    const file = writeRuns([
      JSON.stringify({ skill: "vitest-extension-testing", action: "skill_invoke" }),
      JSON.stringify({ skill: "skill-creator", message: longText }),
    ]);
    const result = makeExecutor().checkPrivacyCompliance(file);
    expect(result.compliant).toBe(false);
    expect(result.issues?.[0]).toContain("1/2 records");
  });

  it("ignores malformed JSON lines rather than flagging them", () => {
    const file = writeRuns(["{not valid json", JSON.stringify({ skill: "vitest-extension-testing" })]);
    const result = makeExecutor().checkPrivacyCompliance(file);
    expect(result.compliant).toBe(true);
  });
});

describe("AuditExecutor manifest validation", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeLibraryDir(withAgents: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-manifest-"));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ skills: { "test-skill": { description: "x", detect_globs: ["**/*"] } } }),
      "utf-8"
    );
    if (withAgents) {
      fs.writeFileSync(
        path.join(dir, "agents.json"),
        JSON.stringify({ agents: { claude: { displayName: "Claude Code" } } }),
        "utf-8"
      );
    }
    return dir;
  }

  function makeTarget(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-target-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("flags 'agents configuration' as missing when agents.json is absent", () => {
    const libraryDir = makeLibraryDir(false);
    const target = makeTarget();
    const result = new AuditExecutor().executeAuditSync(target, libraryDir)!;
    expect(result.manifest.valid).toBe(false);
    expect(result.manifest.missing).toContain("agents configuration");
  });

  it("passes manifest validation when the sibling agents.json is present and non-empty", () => {
    const libraryDir = makeLibraryDir(true);
    const target = makeTarget();
    const result = new AuditExecutor().executeAuditSync(target, libraryDir)!;
    expect(result.checksums.manifestFile).toBe(true);
    expect(result.manifest.valid).toBe(true);
    expect(result.manifest.missing).toBeUndefined();
  });
});
