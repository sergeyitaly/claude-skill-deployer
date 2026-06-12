/** Shared compact dashboard chrome for VS Code webview panels. */

export function dashboardCspMeta(nonce?: string): string {
  if (!nonce) {
    return "";
  }
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
}

export const HOOK_STATUS_STYLES = `
  .hook-banner { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .hook-badge { display: inline-block; font-size: 0.72em; font-weight: 600; padding: 1px 7px; border-radius: 999px; white-space: nowrap; line-height: 1.5; }
  .hook-badge.hook-on { background: color-mix(in srgb, var(--vscode-testing-iconPassed) 22%, transparent); color: var(--vscode-testing-iconPassed); border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 45%, transparent); }
  .hook-badge.hook-off { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: 1px solid var(--vscode-panel-border); }
  .hook-panel .hook-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 3px 0; font-size: 0.82em; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); }
  .hook-panel .hook-row:last-child { border-bottom: none; }
  .hook-section-label { font-size: 0.68em; font-weight: 600; color: var(--vscode-descriptionForeground); margin: 8px 0 4px; text-transform: uppercase; letter-spacing: 0.06em; }
`;

export const DASHBOARD_BASE_STYLES = `
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    line-height: 1.35;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 10px 14px 14px;
    max-width: 920px;
    margin: 0;
  }
  .dash-header { margin-bottom: 10px; }
  h1 { font-size: 1.05em; font-weight: 600; margin: 0 0 2px; letter-spacing: -0.01em; }
  .subtitle, .meta {
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
    margin: 0 0 8px;
  }
  .subtitle code, .meta code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  .panel, .section {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  }
  .panel h2, .section h2 {
    font-size: 0.68em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 6px;
  }
  .panel h3, .subhead {
    font-size: 0.82em;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: 6px;
    margin-bottom: 4px;
  }
  .stat-pill {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 0.78em;
    background: var(--vscode-editor-background);
  }
  .stat-pill b { display: block; font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin-bottom: 2px; font-weight: 600; }
  .stat-pill .val { font-size: 1.05em; font-weight: 600; }
  .summary-line { font-size: 0.88em; margin-bottom: 4px; }
  .skill-row, .list-row { padding: 4px 0; font-size: 0.82em; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
  .skill-row:last-child, .list-row:last-child { border-bottom: none; }
  .skill-head, .list-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .rank { color: var(--vscode-descriptionForeground); min-width: 1.2em; font-size: 0.9em; }
  .cost { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 0.92em; }
  .bar { font-family: var(--vscode-editor-font-family, monospace); letter-spacing: 0.5px; color: var(--vscode-textLink-foreground); font-size: 0.85em; opacity: 0.85; }
  .hint { margin-left: 1.4em; color: var(--vscode-descriptionForeground); font-size: 0.76em; line-height: 1.3; }
  ul { margin: 4px 0 0; padding-left: 16px; font-size: 0.82em; }
  li { margin-bottom: 2px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.82em;
    font-family: inherit;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: 0.45; cursor: default; }
  .metric { display: inline-block; margin-right: 12px; font-size: 0.82em; }
  .note {
    font-size: 0.74em;
    color: var(--vscode-descriptionForeground);
    margin-top: 6px;
    line-height: 1.35;
  }
  .warn {
    background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground) 85%, transparent);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    border-radius: 5px;
    padding: 6px 8px;
    margin-bottom: 8px;
    font-size: 0.8em;
    line-height: 1.35;
  }
  .estimate-banner {
    background: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 70%, transparent);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    padding: 6px 8px;
    margin-bottom: 8px;
    font-size: 0.76em;
    line-height: 1.35;
  }
  .agent-id { color: var(--vscode-descriptionForeground); font-size: 0.92em; font-weight: normal; }
  .agent-block { margin-top: 6px; padding-top: 4px; border-top: 1px dashed color-mix(in srgb, var(--vscode-panel-border) 70%, transparent); }
  .agent-block:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
  .opt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 0.82em; }
  .apply-one { padding: 2px 8px; font-size: 0.76em; }
  .conf-high { color: var(--vscode-testing-iconPassed); font-size: 0.76em; }
  .conf-estimated { color: var(--vscode-editorWarning-foreground); font-size: 0.76em; }
  .conf-low { color: var(--vscode-descriptionForeground); font-size: 0.76em; }
  .roi-high { color: var(--vscode-testing-iconPassed); font-weight: 600; font-size: 0.85em; }
  .table-wrap { overflow-x: auto; margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.78em; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .muted { color: var(--vscode-descriptionForeground); }
  ${HOOK_STATUS_STYLES}
`;

export const DASHBOARD_USAGE_EXTRA_STYLES = `
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 6px; margin-bottom: 8px; }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 6px 8px;
    text-align: center;
    background: var(--vscode-editor-background);
  }
  .card .count { font-size: 1.25em; font-weight: 600; line-height: 1.1; }
  .card .label { font-size: 0.68em; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  .card.active { border-color: color-mix(in srgb, #3fb950 55%, var(--vscode-panel-border)); }
  .card.low-usage { border-color: color-mix(in srgb, #d29922 55%, var(--vscode-panel-border)); }
  .card.unused { border-color: color-mix(in srgb, #8b949e 55%, var(--vscode-panel-border)); }
  .card.needs-attention { border-color: color-mix(in srgb, #f85149 55%, var(--vscode-panel-border)); }
  .card.suggested { border-color: color-mix(in srgb, #58a6ff 55%, var(--vscode-panel-border)); }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 0.72em; font-weight: 600; color: #fff; white-space: nowrap; }
  .badge.active { background: #3fb950; }
  .badge.low-usage { background: #d29922; }
  .badge.unused { background: #8b949e; }
  .badge.needs-attention { background: #f85149; }
  .section .note {
    margin-top: 6px;
    padding: 6px 8px;
    border-left: 2px solid var(--vscode-textLink-foreground);
    background: var(--vscode-textCodeBlock-background);
  }
`;

export const DASHBOARD_WIZARD_EXTRA_STYLES = `
  .lead { color: var(--vscode-descriptionForeground); margin: 0 0 8px; font-size: 0.78em; line-height: 1.35; }
  .step {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    background: var(--vscode-editor-background);
  }
  .step.done { border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 55%, var(--vscode-panel-border)); }
  .step h2 { font-size: 0.82em; font-weight: 600; margin: 0 0 4px; text-transform: none; letter-spacing: normal; color: var(--vscode-foreground); }
  .status { font-size: 0.76em; color: var(--vscode-descriptionForeground); line-height: 1.35; }
  .step .actions { margin-top: 6px; }
`;

export function wrapDashboardHtml(opts: {
  title: string;
  headerHtml: string;
  body: string;
  nonce?: string;
  extraStyles?: string;
  scriptHtml?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${dashboardCspMeta(opts.nonce)}
<style>
${DASHBOARD_BASE_STYLES}
${opts.extraStyles ?? ""}
</style>
</head>
<body>
<header class="dash-header">
  <h1>${opts.title}</h1>
  ${opts.headerHtml}
</header>
${opts.body}
${opts.scriptHtml ?? ""}
</body>
</html>`;
}
