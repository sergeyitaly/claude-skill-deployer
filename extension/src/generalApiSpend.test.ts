import { describe, expect, it } from "vitest";
import {
  generalApiTokensForSession,
  hookTokensForSession,
  residualGeneralApiTokens,
} from "./generalApiSpend";
import { applyTranscriptAttribution, AttributionStore } from "./attributionCollector";
import { ParsedTranscript } from "./transcriptParsers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendSkillRun } from "./runRecording";
import { invalidateLearningCache } from "./learningStateIndex";

describe("residualGeneralApiTokens", () => {
  it("returns session minus hook tokens", () => {
    expect(residualGeneralApiTokens(10_000, 2_500)).toBe(7_500);
    expect(residualGeneralApiTokens(1_000, 2_000)).toBe(0);
  });
});

describe("generalApiTokensForSession", () => {
  const base: ParsedTranscript = {
    agent: "cursor",
    sessionId: "sess-1",
    tokens: 8000,
    activeSkills: [],
    filePath: "/tmp/t.jsonl",
  };

  it("uses full session when no skills and no hooks", () => {
    expect(generalApiTokensForSession(base, os.tmpdir())).toBe(8000);
  });

  it("returns zero when transcript lists skills but no hooks", () => {
    expect(
      generalApiTokensForSession({ ...base, activeSkills: ["ci-preflight"] }, os.tmpdir())
    ).toBe(0);
  });
});

describe("applyTranscriptAttribution", () => {
  it("routes no-skill sessions to base_context", () => {
    const store: AttributionStore = {
      updatedAt: new Date().toISOString(),
      transcriptSkills: {},
      base_context: {},
      unattributed: {},
    };
    const parsed: ParsedTranscript = {
      agent: "claude",
      sessionId: "s-no-skill",
      tokens: 5000,
      activeSkills: [],
      filePath: "/tmp/a.jsonl",
    };
    applyTranscriptAttribution(store, parsed, os.tmpdir());
    expect(store.base_context.claude).toBe(5000);
    expect(store.unattributed.claude).toBeUndefined();
  });

  it("routes hook session residual to base_context", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "gen-api-"));
    appendSkillRun(target, {
      skill: "ci-preflight",
      agent: "claude",
      tokens: 1200,
      success: true,
      action: "skill_invoke",
      session_id: "s-hook",
      metadata: { source: "skill-invoke-hook-v2", invoked: true },
    });
    invalidateLearningCache(target);

    const store: AttributionStore = {
      updatedAt: new Date().toISOString(),
      transcriptSkills: {},
      base_context: {},
      unattributed: {},
    };
    const parsed: ParsedTranscript = {
      agent: "claude",
      sessionId: "s-hook",
      tokens: 5000,
      activeSkills: ["ci-preflight"],
      filePath: "/tmp/b.jsonl",
    };
    applyTranscriptAttribution(store, parsed, target);
    expect(hookTokensForSession(target, "s-hook", "claude")).toBe(1200);
    expect(store.base_context.claude).toBe(3800);
    expect(store.transcriptSkills["ci-preflight"]).toBeUndefined();
  });
});
