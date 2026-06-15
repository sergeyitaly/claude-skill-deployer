import { describe, expect, it } from "vitest";
import { WorkspaceHookStatus } from "./hookOps";
import {
  formatHookStatusBannerHtml,
  formatHookStatusPanelHtml,
  formatHookStatusPlain,
} from "./workspaceHookStatus";

const allOn: WorkspaceHookStatus = {
  attribution: {
    configuredCount: 4,
    applicableCount: 4,
    allConfigured: true,
    agents: [
      { agent: "claude", displayName: "Claude Code", applicable: true, configured: true },
      { agent: "cursor", displayName: "Cursor", applicable: true, configured: true },
    ],
  },
  costControl: {
    sessionSize: true,
    budget: true,
    contextFocus: true,
    practicalFocus: true,
    configured: true,
  },
};

const partial: WorkspaceHookStatus = {
  attribution: {
    configuredCount: 1,
    applicableCount: 2,
    allConfigured: false,
    agents: [
      { agent: "claude", displayName: "Claude Code", applicable: true, configured: true },
      { agent: "cursor", displayName: "Cursor", applicable: true, configured: false },
    ],
  },
  costControl: {
    sessionSize: false,
    budget: true,
    contextFocus: false,
    practicalFocus: false,
    configured: false,
  },
};

describe("workspaceHookStatus formatting", () => {
  it("marks attribution and session/budget in banner HTML", () => {
    const html = formatHookStatusBannerHtml(allOn);
    expect(html).toContain("Attribution v2: on");
    expect(html).toContain("Session size: on");
    expect(html).toContain("Daily budget: on");
    expect(html).toContain("Context focus: on");
    expect(html).toContain("Practical focus: on");
    expect(html).toContain("hook-on");
  });

  it("shows partial attribution in panel HTML", () => {
    const html = formatHookStatusPanelHtml(partial);
    expect(html).toContain("attribution missing");
    expect(html).toContain("Session size warnings");
    expect(html).toContain("Context focus grounding");
    expect(html).toContain("Practical / deployment focus");
    expect(html).toContain("hook-off");
  });

  it("shows VS Code attribution gap warning in panel HTML", () => {
    const withGap: WorkspaceHookStatus = {
      ...allOn,
      claudeVscodeGap: {
        detected: true,
        preToolWorkaroundInstalled: false,
        mitigated: false,
        vscodeSessionCount: 1,
        toolUseCount: 20,
        postToolUseHookFires: 0,
        postToolUseConfigured: true,
        summary: "Claude VS Code gap: 20 tool use(s), zero PostToolUse hook fires.",
        recommendation: "Re-sync hooks to install the PreToolUse workaround.",
      },
    };
    const html = formatHookStatusPanelHtml(withGap);
    expect(html).toContain("Claude VS Code");
    expect(html).toContain("PreToolUse workaround missing");
  });

  it("formats plain status for onboarding", () => {
    expect(formatHookStatusPlain(partial)).toContain("Attribution v2: partial (1/2 agents)");
    expect(formatHookStatusPlain(partial)).toContain("Session size warnings: off");
    expect(formatHookStatusPlain(partial)).toContain("Daily budget warnings: on");
    expect(formatHookStatusPlain(partial)).toContain("Context focus grounding: off");
    expect(formatHookStatusPlain(partial)).toContain("Practical/deployment focus: off");
  });
});
