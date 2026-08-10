/**
 * Integration tests for hookHandlers.ts
 * Covers: signalIsNegated unit tests, handleHookRequest dispatch, opportunity detection,
 * negation suppression, and session coach config flag.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (_: string, d: unknown) => d }) },
  commands: { executeCommand: vi.fn() },
  window: { showInformationMessage: vi.fn(() => Promise.resolve(undefined)) },
}));
vi.mock("./runsStore", () => ({
  appendSkillRun: vi.fn(), appendToolUse: vi.fn(), readCachedEnrichedRuns: vi.fn(() => []),
}));
vi.mock("./contextFocusConfig", () => ({
  readContextFocusConfig: () => ({ enabled: false }), effectiveContextFocusLevel: () => "balanced",
}));
vi.mock("./practicalFocusConfig", () => ({ readPracticalFocusConfig: () => ({ enabled: false }) }));
vi.mock("./budgetConfig", () => ({
  readBudgetConfig: () => ({ mode: "normal", dailyBudgetUsd: 0, highTierSkills: [], mediumTierSkills: [] }),
  readBudgetState: () => ({}), writeBudgetState: vi.fn(),
}));
vi.mock("./budgetOps", () => ({ disableHighTierSkills: () => [] }));
vi.mock("./usageCost", () => ({ computeTodayCreditUsage: () => ({ totalCost: 0 }) }));
vi.mock("./usageStats", () => ({ formatTokenCount: () => "0", readRunRecords: () => [] }));
vi.mock("./officialSkillsSync", () => ({
  checkOfficialSkillUpdates: () => ({ updates: [] }),
  workspaceUsesOfficialSkillUpdater: () => false,
  formatOfficialSkillsSessionContext: () => "",
  resolveSkillsLibraryDir: () => null,
}));
vi.mock("./sessionSkillApply", () => ({
  processSessionSkillApplyRequest: vi.fn(),
  resolveProposedSkillNamesWithSource: () => [],
  queueSessionSkillApplyRequest: vi.fn(),
}));
vi.mock("./taskSkillFocus", () => ({ applyTaskSkillFocusFromProposals: vi.fn() }));
vi.mock("./branchProfiles", () => ({
  applyBranchProfile: vi.fn(), getCurrentBranch: () => "main", loadBranchProfile: () => null,
}));
vi.mock("./hookHealth", () => ({ appendHookHealth: vi.fn() }));
vi.mock("./proposalOutcome", () => ({
  recordSessionProposalOutcome: vi.fn(), recordSessionRejectionFeedback: vi.fn(),
}));
vi.mock("./taskSkillProposals", () => ({
  readTaskSkillProposals: vi.fn(() => ({ proposals: [] })),
  formatSessionStartSkillRecommendations: vi.fn(() => ""),
  formatPromptTimeSkillRecommendation: vi.fn(() => null),
}));
vi.mock("./userNotify", () => ({ notifySuggestion: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("./skillEnrichmentProposal", () => ({
  getApprovedUnappliedSummary: vi.fn(() => null),
  formatApprovedEnrichmentReminderText: vi.fn(() => ""),
}));
vi.mock("./emergencyCutoff", () => ({
  getActiveEmergencyCutoffReminder: vi.fn(() => null),
  formatEmergencyCutoffReminderText: vi.fn(() => ""),
}));
vi.mock("./promptIntelligence", () => ({
  // antiPatterns must be present (even empty) — handleSessionCoach reads it
  // unconditionally on a session's 2nd+ prompt (analysis.antiPatterns.find(...)).
  analyzePrompt: () => ({ score: 80, recommendations: [], antiPatterns: [] }),
  appendPromptRecord: vi.fn(),
}));
vi.mock("./haceCoaching", () => ({ getSessionCoachHints: () => [] }));
vi.mock("./coachingLearning", () => ({ shouldShowAdvice: () => false, recordAdviceShown: () => false }));
vi.mock("./hookServer", () => ({ hookBaseUrl: () => "http://127.0.0.1:4895" }));
vi.mock("./adoptionIntelligence", () => ({
  isDormantSkill: () => false,
  shouldSurfaceProposals: () => ({ shouldPropose: true, reason: "test" }),
  computeAdoptionMetrics: () => ({ hasData: false }),
  formatAdoptionDashboardHtml: () => "",
  formatAdoptionCoachHtml: () => "",
}));
vi.mock("./coachConfig", () => ({
  readCoachConfig: vi.fn(() => ({ enabled: true, maxHintsPerSession: 3 })),
}));

import { handleHookRequest, signalIsNegated } from "./hookHandlers";

// ---------------------------------------------------------------------------
// signalIsNegated — unit tests (no mocks needed)
// ---------------------------------------------------------------------------

describe("signalIsNegated", () => {
  it("returns false when keyword present without negation", () => {
    expect(signalIsNegated("deploy with terraform", /terraform\b/i)).toBe(false);
  });

  it("detects 'don't use X' pattern", () => {
    expect(signalIsNegated("I don't want to use terraform here", /terraform\b/i)).toBe(true);
  });

  it("detects 'avoid X' pattern", () => {
    expect(signalIsNegated("avoid terraform in this case", /terraform\b/i)).toBe(true);
  });

  it("detects 'not using X' pattern", () => {
    expect(signalIsNegated("we are not using terraform for this", /terraform\b/i)).toBe(true);
  });

  it("detects 'without X' pattern", () => {
    expect(signalIsNegated("do this without terraform", /terraform\b/i)).toBe(true);
  });

  it("does not fire across sentence boundaries", () => {
    // "Don't" in first sentence, "terraform" in second — different sentences → no suppression
    expect(signalIsNegated("Don't do this. Use terraform to deploy.", /terraform\b/i)).toBe(false);
  });

  it("returns false when signal not in text", () => {
    expect(signalIsNegated("hello world", /terraform\b/i)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(signalIsNegated("", /terraform\b/i)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — dispatch
// ---------------------------------------------------------------------------

describe("handleHookRequest dispatch", () => {
  it("returns {} for unknown hook name", async () => {
    const result = await handleHookRequest({
      hookName: "nonexistent-hook",
      agent: "claude",
      cwd: os.tmpdir(),
      body: {},
    });
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — prompt-context with opportunity detection
// ---------------------------------------------------------------------------

describe("handleHookRequest prompt-context opportunity detection", () => {
  let tmpDir: string;
  let transcriptFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-test-"));
    // Create installed skill directory
    fs.mkdirSync(path.join(tmpDir, ".claude", "skills", "terraform-plan-review"), { recursive: true });
    // Create transcript file
    transcriptFile = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(text: string): void {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "text", text }] },
    });
    fs.writeFileSync(transcriptFile, line + "\n", "utf-8");
  }

  it("surfaces skill hint when terraform keyword matches", async () => {
    writeTranscript("how do I deploy with terraform?");
    const result = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "test-session" },
    });
    const output = JSON.stringify(result);
    expect(output).toContain("[Skill Opportunity]");
    expect(output).toContain("terraform-plan-review");
  });

  it("suppresses hint when terraform is negated", async () => {
    writeTranscript("I don't want to use terraform for this task");
    const result = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "test-session-neg" },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("[Skill Opportunity]");
  });

  it("suppresses hint when skill is not installed", async () => {
    // No vitest-extension-testing directory — only terraform-plan-review exists
    writeTranscript("run vitest benchmarks");
    const result = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "test-session-no-install" },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("vitest-extension-testing");
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — session coach config flag
// ---------------------------------------------------------------------------

describe("handleHookRequest session coach disabled", () => {
  it("suppresses coaching hints when enabled=false but does not throw", async () => {
    const { readCoachConfig } = await import("./coachConfig");
    vi.mocked(readCoachConfig).mockReturnValueOnce({ enabled: false, maxHintsPerSession: 3 });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-coach-"));
    const transcriptFile = path.join(tmpDir, "s.jsonl");
    fs.writeFileSync(transcriptFile,
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "help me" }] } }) + "\n",
    "utf-8");

    const result = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "coach-off-session" },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("[HACE Coach]");
    expect(output).not.toContain("[Prompt Coach]");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — official-skills session-start recommendations (Fix 1)
// ---------------------------------------------------------------------------

describe("handleHookRequest official-skills — session-start recommendations", () => {
  it("surfaces the session-start recommendation digest when proposals exist", async () => {
    const { formatSessionStartSkillRecommendations } = await import("./taskSkillProposals");
    vi.mocked(formatSessionStartSkillRecommendations).mockReturnValueOnce(
      "Recommended skills for this workspace:\n\n1. vitest-extension-testing (88%)\n   Reason: vitest.config.ts detected\n\n   Invoke:\n   /vitest-extension-testing"
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-official-"));
    const result = await handleHookRequest({
      hookName: "official-skills",
      agent: "claude",
      cwd: tmpDir,
      body: { source: "startup" },
    });
    const output = JSON.stringify(result);
    expect(output).toContain("Recommended skills for this workspace:");
    expect(output).toContain("vitest-extension-testing (88%)");
    expect(output).toContain("/vitest-extension-testing");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("omits the recommendation block when there are no eligible proposals", async () => {
    const { formatSessionStartSkillRecommendations } = await import("./taskSkillProposals");
    vi.mocked(formatSessionStartSkillRecommendations).mockReturnValueOnce("");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-official-empty-"));
    const result = await handleHookRequest({
      hookName: "official-skills",
      agent: "claude",
      cwd: tmpDir,
      body: { source: "startup" },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("Recommended skills for this workspace:");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — prompt-context real-proposal recommendation (Fix 2)
// ---------------------------------------------------------------------------

describe("handleHookRequest prompt-context — real-proposal recommendation", () => {
  let tmpDir: string;
  let transcriptFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-fix2-"));
    transcriptFile = path.join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTranscript(text: string): void {
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } }) + "\n",
      "utf-8"
    );
  }

  it("surfaces the real proposal recommendation instead of the keyword engine", async () => {
    const { formatPromptTimeSkillRecommendation } = await import("./taskSkillProposals");
    vi.mocked(formatPromptTimeSkillRecommendation).mockReturnValueOnce({
      skillName: "vitest-extension-testing",
      text: "[Skill Recommendation] vitest-extension-testing (88%) — vitest.config.ts detected. Invoke: /vitest-extension-testing",
    });

    // Prompt also matches the keyword engine's terraform signal — the real-proposal
    // path must win and the keyword engine must not additionally fire.
    writeTranscript("how do I deploy with terraform?");
    const result = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "fix2-session" },
    });
    const output = JSON.stringify(result);
    expect(output).toContain("[Skill Recommendation]");
    expect(output).toContain("vitest-extension-testing (88%)");
    expect(output).not.toContain("[Skill Opportunity]");
  });

  it("does not repeat the same skill recommendation twice in one session", async () => {
    const { formatPromptTimeSkillRecommendation } = await import("./taskSkillProposals");
    vi.mocked(formatPromptTimeSkillRecommendation).mockImplementation(
      (_target: string, excludeNames: Set<string>) => {
        if (excludeNames.has("vitest-extension-testing")) return null;
        return {
          skillName: "vitest-extension-testing",
          text: "[Skill Recommendation] vitest-extension-testing (88%) — reason. Invoke: /vitest-extension-testing",
        };
      }
    );

    writeTranscript("run the vitest tests");
    const first = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "fix2-cooldown-session" },
    });
    expect(JSON.stringify(first)).toContain("[Skill Recommendation]");

    const second = await handleHookRequest({
      hookName: "prompt-context",
      agent: "claude",
      cwd: tmpDir,
      body: { transcript_path: transcriptFile, session_id: "fix2-cooldown-session" },
    });
    expect(JSON.stringify(second)).not.toContain("[Skill Recommendation]");
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — official-skills approved enrichment reminder (Fix 3)
// ---------------------------------------------------------------------------

describe("handleHookRequest official-skills — approved enrichment reminder", () => {
  it("surfaces the reminder text and fires a notification when proposals are approved", async () => {
    const { getApprovedUnappliedSummary, formatApprovedEnrichmentReminderText } =
      await import("./skillEnrichmentProposal");
    const { notifySuggestion } = await import("./userNotify");
    vi.mocked(getApprovedUnappliedSummary).mockReturnValueOnce({
      count: 4,
      bySkill: { "skill-creator": 2, "vitest-extension-testing": 1, "skill-feedback-adaptation": 1 },
      oldestAgeDays: 12,
    });
    vi.mocked(formatApprovedEnrichmentReminderText).mockReturnValueOnce(
      "4 approved skill improvements are waiting.\n\n- skill-creator (2)\n- vitest-extension-testing (1)\n- skill-feedback-adaptation (1)\n\nOpen enrichment panel."
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-enrich-"));
    const result = await handleHookRequest({
      hookName: "official-skills",
      agent: "claude",
      cwd: tmpDir,
      body: { source: "startup" },
    });
    const output = JSON.stringify(result);
    expect(output).toContain("4 approved skill improvements are waiting.");
    expect(output).toContain("skill-creator (2)");
    expect(output).toContain("Open enrichment panel.");
    expect(notifySuggestion).toHaveBeenCalledWith(
      expect.stringContaining("4 approved skill improvements waiting to be applied."),
      ["Open Enrichment Panel", "Dismiss"],
      expect.objectContaining({ dedupeKey: expect.stringContaining("enrichment-reminder|") })
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not push a reminder or notify when there are no approved-unapplied proposals", async () => {
    const { getApprovedUnappliedSummary } = await import("./skillEnrichmentProposal");
    const { notifySuggestion } = await import("./userNotify");
    vi.mocked(getApprovedUnappliedSummary).mockReturnValueOnce(null);
    vi.mocked(notifySuggestion).mockClear();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-enrich-none-"));
    const result = await handleHookRequest({
      hookName: "official-skills",
      agent: "claude",
      cwd: tmpDir,
      body: { source: "startup" },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("approved skill improvement");
    expect(notifySuggestion).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — official-skills emergency cutoff reminder
// ---------------------------------------------------------------------------

describe("handleHookRequest official-skills — emergency cutoff reminder", () => {
  it("surfaces the reminder text and fires a notification while cutoff is active", async () => {
    const { getActiveEmergencyCutoffReminder, formatEmergencyCutoffReminderText } =
      await import("./emergencyCutoff");
    const { notifySuggestion } = await import("./userNotify");
    vi.mocked(getActiveEmergencyCutoffReminder).mockReturnValueOnce({
      daysSinceTriggered: 33,
      costUsd: 126.8,
      disabledCount: 17,
    });
    vi.mocked(formatEmergencyCutoffReminderText).mockReturnValueOnce(
      "[Claude Skills] Emergency cutoff still active (triggered 33 days ago at ~$126.80 spend): 17 skill(s) forced off."
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-emergency-"));
    const result = await handleHookRequest({
      hookName: "official-skills",
      agent: "claude",
      cwd: tmpDir,
      body: { source: "startup" },
    });
    const output = JSON.stringify(result);
    expect(output).toContain("Emergency cutoff still active");
    expect(output).toContain("17 skill(s) forced off");
    expect(notifySuggestion).toHaveBeenCalledWith(
      expect.stringContaining("Emergency cutoff still active"),
      ["Reset Emergency Cutoff", "Dismiss"],
      expect.objectContaining({ dedupeKey: expect.stringContaining("emergency-cutoff-reminder|") })
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not push a reminder or notify when cutoff is not active", async () => {
    const { getActiveEmergencyCutoffReminder } = await import("./emergencyCutoff");
    const { notifySuggestion } = await import("./userNotify");
    vi.mocked(getActiveEmergencyCutoffReminder).mockReturnValueOnce(null);
    vi.mocked(notifySuggestion).mockClear();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-emergency-none-"));
    const result = await handleHookRequest({
      hookName: "official-skills",
      agent: "claude",
      cwd: tmpDir,
      body: { source: "startup" },
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain("Emergency cutoff");
    expect(notifySuggestion).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// handleHookRequest — session-stop routine session summary
// ---------------------------------------------------------------------------

describe("handleHookRequest session-stop — routine session summary", () => {
  it("shows a one-time summary toast when a session has enough recorded runs", async () => {
    const { readCachedEnrichedRuns } = await import("./runsStore");
    const vscode = await import("vscode");
    const sessionId = "session-summary-enough-runs";
    // recordSessionAdoptionOutcomes (unmocked, real implementation) also calls
    // readCachedEnrichedRuns before maybeNotifySessionSummary does, so a *Once queue
    // entry would be consumed by that earlier call — use a persistent return value.
    vi.mocked(readCachedEnrichedRuns).mockReturnValue([
      { session_id: sessionId, skill: "cross-platform-scripting", cost: 0.1, success: true },
      { session_id: sessionId, skill: "cross-platform-scripting", cost: 0.2, success: true },
      { session_id: sessionId, skill: "pdf", cost: 0.05, success: false },
      { session_id: "other-session", skill: "pdf", cost: 5, success: true },
    ] as any);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-session-summary-"));
    await handleHookRequest({
      hookName: "session-stop",
      agent: "claude",
      cwd: tmpDir,
      body: { session_id: sessionId },
    });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("3 skill invocation(s)"),
      "Show Usage Report"
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("67% successful"),
      "Show Usage Report"
    );

    vi.mocked(readCachedEnrichedRuns).mockReset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not show a summary when a session has too few recorded runs", async () => {
    const { readCachedEnrichedRuns } = await import("./runsStore");
    const vscode = await import("vscode");
    const sessionId = "session-summary-too-few-runs";
    vi.mocked(readCachedEnrichedRuns).mockReturnValue([
      { session_id: sessionId, skill: "pdf", cost: 0.05, success: true },
    ] as any);
    vi.mocked(vscode.window.showInformationMessage).mockClear();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-session-summary-few-"));
    await handleHookRequest({
      hookName: "session-stop",
      agent: "claude",
      cwd: tmpDir,
      body: { session_id: sessionId },
    });

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

    vi.mocked(readCachedEnrichedRuns).mockReset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("only shows the summary once per session even if session-stop fires again", async () => {
    const { readCachedEnrichedRuns } = await import("./runsStore");
    const vscode = await import("vscode");
    const sessionId = "session-summary-idempotent";
    const runs = [
      { session_id: sessionId, skill: "pdf", cost: 0.1, success: true },
      { session_id: sessionId, skill: "pdf", cost: 0.1, success: true },
      { session_id: sessionId, skill: "pdf", cost: 0.1, success: true },
    ] as any;
    vi.mocked(readCachedEnrichedRuns).mockReturnValue(runs);
    vi.mocked(vscode.window.showInformationMessage).mockClear();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hh-session-summary-once-"));
    await handleHookRequest({ hookName: "session-stop", agent: "claude", cwd: tmpDir, body: { session_id: sessionId } });
    await handleHookRequest({ hookName: "session-stop", agent: "claude", cwd: tmpDir, body: { session_id: sessionId } });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    vi.mocked(readCachedEnrichedRuns).mockReset();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
