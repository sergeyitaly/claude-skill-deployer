import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Manifest } from "./skillOps";
import { SKILL_INVOKE_HOOK_SOURCE } from "./runRecording";
import {
  evaluateTaskDrift,
  processTaskDriftReproposal,
  refreshProposalsForDrift,
  SESSION_WATCH_REL,
} from "./taskDriftReproposal";
import { writeTaskSkillProposals } from "./taskSkillProposals";

const manifest: Manifest = {
  skills: {
    "ci-pipeline-debug": {
      description: "CI pipeline failure debugging",
      detect_globs: ["**/.gitlab-ci.yml"],
    },
    "terraform-plan-review": {
      description: "Terraform plan review",
      detect_globs: ["**/*.tf"],
    },
    pdf: { description: "PDF files", detect_globs: ["**/*.pdf"] },
  },
};

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) => defaultValue,
    }),
  },
}));

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: (key: string) => key === "taskDriftReproposal" || key === "taskSkillFocus",
}));

function writeRuns(target: string, rows: Record<string, unknown>[]): void {
  const dir = path.join(target, ".claude", "learning");
  fs.mkdirSync(dir, { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "runs.jsonl"), body, "utf-8");
}

function seedProposals(target: string): void {
  writeTaskSkillProposals(target, {
    version: 1,
    generatedAt: new Date().toISOString(),
    taskSummary: "Fix CI",
    proposals: [
      { name: "ci-pipeline-debug", reason: "CI task", confidence: 90, installed: true },
    ],
  });
}

describe("taskDriftReproposal", () => {
  let target = "";

  afterEach(() => {
    if (target && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    target = "";
  });

  it("does not repropose when off-profile invokes are below threshold", () => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
    seedProposals(target);
    writeRuns(target, [
      {
        ts: new Date().toISOString(),
        skill: "terraform-plan-review",
        action: "skill_invoke",
        agent: "cursor",
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true, not_in_active_profile: true },
      },
    ]);

    const evaln = evaluateTaskDrift(target);
    expect(evaln.shouldRepropose).toBe(false);
    expect(evaln.offProfileInvokeCount).toBe(1);
  });

  it("reproposes when off-profile invokes meet threshold", () => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
    seedProposals(target);
    const ts = new Date().toISOString();
    writeRuns(target, [
      {
        ts,
        skill: "terraform-plan-review",
        action: "skill_invoke",
        agent: "cursor",
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true, not_in_active_profile: true },
      },
      {
        ts,
        skill: "pdf",
        action: "skill_invoke",
        agent: "cursor",
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true, not_in_active_profile: true },
      },
    ]);

    const evaln = evaluateTaskDrift(target);
    expect(evaln.shouldRepropose).toBe(true);
    expect(evaln.triggers).toContain("off_profile");

    const refresh = refreshProposalsForDrift(target, manifest, evaln);
    expect(refresh.refreshed).toBe(true);
    expect(refresh.file?.proposals.some((p) => p.name === "terraform-plan-review")).toBe(true);
  });

  it("reproposes on large session when session-watch is warn", () => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
    seedProposals(target);
    const watchDir = path.join(target, ".claude", "learning");
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      path.join(target, SESSION_WATCH_REL),
      JSON.stringify({ "sess-1": "warn" }, null, 2) + "\n",
      "utf-8"
    );

    const evaln = evaluateTaskDrift(target);
    expect(evaln.shouldRepropose).toBe(true);
    expect(evaln.triggers).toContain("session_size");
  });

  it("processTaskDriftReproposal writes prompt file and state", () => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "drift-"));
    seedProposals(target);
    const ts = new Date().toISOString();
    writeRuns(target, [
      {
        ts,
        skill: "terraform-plan-review",
        action: "skill_invoke",
        agent: "cursor",
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true, not_in_active_profile: true },
      },
      {
        ts,
        skill: "pdf",
        action: "skill_invoke",
        agent: "cursor",
        metadata: { source: SKILL_INVOKE_HOOK_SOURCE, invoked: true, not_in_active_profile: true },
      },
    ]);

    const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    const result = processTaskDriftReproposal(target, libraryDir, manifest);
    expect(result.reproposed).toBe(true);

    const prompt = JSON.parse(
      fs.readFileSync(path.join(target, ".claude", "learning", "task-drift-prompt.json"), "utf-8")
    );
    expect(prompt.shouldInject).toBe(true);
    expect(prompt.message).toContain("Task scope drift");
  });
});
