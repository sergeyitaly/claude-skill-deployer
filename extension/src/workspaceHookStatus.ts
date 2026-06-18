import { WorkspaceHookStatus } from "./hookOps";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function hookLabel(on: boolean, text: string): string {
  const cls = on ? "hook-on" : "hook-off";
  return `<span class="hook-badge ${cls}">${escapeHtml(text)}</span>`;
}

/** One-line hook summary for compact headers. */
export function formatHookStatusBannerHtml(status: WorkspaceHookStatus): string {
  const { attribution, costControl } = status;
  const attrText =
    attribution.applicableCount === 0
      ? "Attribution v2: n/a"
      : attribution.allConfigured
        ? `Attribution v2: on (${attribution.configuredCount}/${attribution.applicableCount})`
        : `Attribution v2: partial (${attribution.configuredCount}/${attribution.applicableCount})`;

  const parts = [
    hookLabel(attribution.allConfigured && attribution.applicableCount > 0, attrText),
    hookLabel(costControl.sessionSize, costControl.sessionSize ? "Session size: on" : "Session size: off"),
    hookLabel(costControl.budget, costControl.budget ? "Daily budget: on" : "Daily budget: off"),
    hookLabel(costControl.contextFocus, costControl.contextFocus ? "Context focus: on" : "Context focus: off"),
    hookLabel(costControl.practicalFocus, costControl.practicalFocus ? "Practical focus: on" : "Practical focus: off"),
  ];

  return `<div class="hook-banner">${parts.join(" ")}</div>`;
}

/** Detailed hook panel with per-agent attribution rows. */
export function formatHookStatusPanelHtml(status: WorkspaceHookStatus): string {
  const agentRows = status.attribution.agents
    .filter((a) => a.applicable)
    .map((a) => {
      const label = a.configured ? "enabled" : "missing";
      const cls = a.configured ? "hook-on" : "hook-off";
      return `<div class="hook-row">
        <span>${escapeHtml(a.displayName)} <span class="agent-id">(${escapeHtml(a.agent)})</span></span>
        <span class="hook-badge ${cls}">attribution ${label}</span>
      </div>`;
    })
    .join("");

  const costRows = [
    `<div class="hook-row">
      <span>Session size warnings <span class="agent-id">(Claude Code)</span></span>
      <span class="hook-badge ${status.costControl.sessionSize ? "hook-on" : "hook-off"}">${status.costControl.sessionSize ? "on" : "off"}</span>
    </div>`,
    `<div class="hook-row">
      <span>Daily budget warnings <span class="agent-id">(Claude Code)</span></span>
      <span class="hook-badge ${status.costControl.budget ? "hook-on" : "hook-off"}">${status.costControl.budget ? "on" : "off"}</span>
    </div>`,
    `<div class="hook-row">
      <span>Context focus grounding <span class="agent-id">(Claude Code)</span></span>
      <span class="hook-badge ${status.costControl.contextFocus ? "hook-on" : "hook-off"}">${status.costControl.contextFocus ? "on" : "off"}</span>
    </div>`,
    `<div class="hook-row">
      <span>Practical / deployment focus <span class="agent-id">(Claude Code)</span></span>
      <span class="hook-badge ${status.costControl.practicalFocus ? "hook-on" : "hook-off"}">${status.costControl.practicalFocus ? "on" : "off"}</span>
    </div>`,
  ].join("");

  const attrSummary =
    status.attribution.applicableCount === 0
      ? "No enabled agents support attribution hooks."
      : status.attribution.allConfigured
        ? `Attribution v2 active for all ${status.attribution.applicableCount} enabled agent(s).`
        : `${status.attribution.configuredCount} of ${status.attribution.applicableCount} agent(s) have attribution hooks — reload the window or run Enable Attribution Hooks (v2).`;

  const gap = status.claudeVscodeGap;
  const gapBlock =
    gap && (gap.detected || gap.mitigated)
      ? `<div class="warn" style="margin-top:0.75rem"><b>Claude VS Code</b> — ${escapeHtml(gap.summary)}${
          gap.recommendation ? `<br><span class="note">${escapeHtml(gap.recommendation)}</span>` : ""
        }${
          gap.preToolWorkaroundInstalled
            ? `<br><span class="hook-badge hook-on">PreToolUse workaround installed</span>`
            : gap.detected
              ? `<br><span class="hook-badge hook-off">PreToolUse workaround missing — re-sync hooks</span>`
              : ""
        }</div>`
      : gap?.summary
        ? `<p class="note">${escapeHtml(gap.summary)}</p>`
        : "";

  const g = status.guards;
  const guardsRows = [
    `<div class="hook-row">
      <span>Dir cache guard <span class="agent-id">(PreToolUse)</span></span>
      <span class="hook-badge ${g.dirCacheGuard ? "hook-on" : "hook-off"}">${g.dirCacheGuard ? "on" : "off"}</span>
    </div>`,
    `<div class="hook-row">
      <span>CLI loop guard <span class="agent-id">(PostToolUse)</span></span>
      <span class="hook-badge ${g.cliLoopGuard ? "hook-on" : "hook-off"}">${g.cliLoopGuard ? "on" : "off"}</span>
    </div>`,
    `<div class="hook-row">
      <span>File split advisor <span class="agent-id">(PostToolUse)</span></span>
      <span class="hook-badge ${g.fileSplitAdvisor ? "hook-on" : "hook-off"}">${g.fileSplitAdvisor ? "on" : "off"}</span>
    </div>`,
  ].join("");
  const degradedBanner = g.degraded
    ? `<div class="warn" style="margin-top:0.5rem">
        ⚠ Guard hooks are configured but the VS Code extension hook server is not running —
        enforcement is inactive. Reload VS Code or ensure the Claude Skills extension is active.
      </div>`
    : "";

  return `<div class="panel hook-panel">
    <h2>Workspace hooks</h2>
    <p class="note" style="margin-top:0">${escapeHtml(attrSummary)} Session/budget hooks apply to Claude Code only.</p>
    ${gapBlock}
    <div class="hook-section-label">Attribution v2 (per-skill logging)</div>
    ${agentRows || "<p class=\"note\">No attribution-capable agents enabled.</p>"}
    <div class="hook-section-label">Cost control (Claude Code)</div>
    ${costRows}
    <div class="hook-section-label">Efficiency guards</div>
    ${guardsRows}
    ${degradedBanner}
  </div>`;
}

/** Plain text for onboarding wizard step status. */
export function formatHookStatusPlain(status: WorkspaceHookStatus): string {
  const attr =
    status.attribution.applicableCount === 0
      ? "Attribution v2: not applicable"
      : status.attribution.allConfigured
        ? `Attribution v2: enabled (${status.attribution.configuredCount}/${status.attribution.applicableCount} agents)`
        : `Attribution v2: partial (${status.attribution.configuredCount}/${status.attribution.applicableCount} agents)`;

  const session = status.costControl.sessionSize ? "Session size warnings: on" : "Session size warnings: off";
  const budget = status.costControl.budget ? "Daily budget warnings: on" : "Daily budget warnings: off";
  const focus = status.costControl.contextFocus ? "Context focus grounding: on" : "Context focus grounding: off";
  const practical = status.costControl.practicalFocus
    ? "Practical/deployment focus: on"
    : "Practical/deployment focus: off";

  const g = status.guards;
  const guardParts = [
    g.dirCacheGuard ? "dir-cache: on" : "dir-cache: off",
    g.cliLoopGuard ? "cli-loop: on" : "cli-loop: off",
    g.fileSplitAdvisor ? "file-split: on" : "file-split: off",
  ];
  const guardsSummary = `Guards (${guardParts.join(", ")})${g.degraded ? " ⚠ DEGRADED — hook server not running" : ""}`;

  return `${attr}. ${session}. ${budget}. ${focus}. ${practical}. ${guardsSummary}.`;
}

export { HOOK_STATUS_STYLES } from "./dashboardStyles";
