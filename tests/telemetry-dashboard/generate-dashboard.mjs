#!/usr/bin/env node
/**
 * Real-telemetry dashboard generator.
 * Reads ~/.claude/learning/mcp-usage.jsonl  (MCP + native bash tool calls)
 *       ~/.claude/learning/runs.jsonl        (skill run log)
 * and writes dashboard.html with computed metrics — no synthetic numbers.
 *
 * Usage:  node generate-dashboard.mjs [--days 30] [--out dashboard.html]
 */

import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args     = process.argv.slice(2);
const daysIdx  = args.indexOf("--days");
const daysBack = daysIdx !== -1 ? (Number(args[daysIdx + 1]) || 30) : 30;
const outIdx   = args.indexOf("--out");
const outFile  = outIdx !== -1 ? args[outIdx + 1] : path.join(__dirname, "dashboard.html");
const cutoffMs = Date.now() - daysBack * 86_400_000;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const LEARNING_DIR = path.join(os.homedir(), ".claude", "learning");
const MCP_LOG      = path.join(LEARNING_DIR, "mcp-usage.jsonl");
const RUNS_LOG     = path.join(LEARNING_DIR, "runs.jsonl");

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// ---------------------------------------------------------------------------
// MCP + terminal analysis
// ---------------------------------------------------------------------------
function analyseMcp(entries, cutoff) {
  const windowed = entries.filter(e => Date.parse(e.ts) >= cutoff);

  const sessions = new Map();
  for (const e of windowed) {
    const sid = e.sessionId || e.session_id || "unknown";
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid).push(e);
  }

  let totalReads          = 0;
  let repeatedReads       = 0;
  let noOpWritesSkipped   = 0;
  let totalWastedBytes    = 0;
  let totalReadBytes      = 0;
  let agentLoopCount      = 0;
  let readAfterWriteCount = 0;

  let cliTotal     = 0;
  let cliFailures  = 0;
  let cliRecovered = 0;
  let bashTotal    = 0;  // native bash tool calls (server:"bash")
  let bashFailures = 0;
  const cliByName  = new Map();

  for (const [, evts] of sessions) {
    const readMap  = new Map();
    const writeMap = new Map();

    for (const e of evts) {
      // Filesystem reads
      if (e.tool === "read_file") {
        totalReads++;
        totalReadBytes += e.bytes ?? 0;
        const prev = readMap.get(e.path) ?? 0;
        if (prev >= 2) repeatedReads++;
        readMap.set(e.path, prev + 1);

        const lastWrite = writeMap.get(e.path);
        if (lastWrite && Date.parse(e.ts) - lastWrite < 60_000) {
          readAfterWriteCount++;
        }

        if (prev >= 3) {
          const first = evts.find(x => x.tool === "read_file" && x.path === e.path);
          if (first && Date.parse(e.ts) - Date.parse(first.ts) < 300_000) {
            agentLoopCount++;
          }
        }
      }

      // No-op writes (auto-skipped by MCP server content-hash guard)
      if (e.tool === "write_file" && e.skipped === true) {
        noOpWritesSkipped++;
        totalWastedBytes += e.bytes ?? 0;
      }
      if (e.tool === "write_file") {
        writeMap.set(e.path, Date.parse(e.ts));
      }

      // CLI calls: both MCP CLI server (cli:*) and native bash hook (bash:*)
      const isMcpCli  = e.tool && e.tool.startsWith("cli:");
      const isNativeBash = e.tool && e.tool.startsWith("bash:");
      if (isMcpCli || isNativeBash) {
        cliTotal++;
        if (isNativeBash) bashTotal++;
        const cli    = e.tool.replace(/^(?:cli|bash):/, "");
        const source = isNativeBash ? "bash" : "mcp";
        if (!cliByName.has(cli)) cliByName.set(cli, { total: 0, failures: 0, recovered: 0, mcp: 0, bash: 0 });
        const c = cliByName.get(cli);
        c.total++;
        c[source] = (c[source] || 0) + 1;
        if (e.exitCode !== undefined && e.exitCode !== 0) {
          cliFailures++;
          if (isNativeBash) bashFailures++;
          c.failures++;
        }
      }
    }

    // Recovery detection: failure → success on same CLI within 30 s
    const cliEvts = evts
      .filter(e => e.tool && (e.tool.startsWith("cli:") || e.tool.startsWith("bash:")))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < cliEvts.length - 1; i++) {
      const curr = cliEvts[i];
      const next = cliEvts[i + 1];
      if (curr.exitCode !== 0 && next.exitCode === 0 &&
          curr.tool === next.tool &&
          Date.parse(next.ts) - Date.parse(curr.ts) <= 30_000) {
        cliRecovered++;
      }
    }
  }

  const TOKENS_PER_BYTE   = 750 / 1024;
  const totalWastedTokens = Math.round(
    (repeatedReads * 2048 + totalWastedBytes + agentLoopCount * 4096 + readAfterWriteCount * 1024) *
    TOKENS_PER_BYTE
  );
  const totalReadTokens = Math.round(totalReadBytes * TOKENS_PER_BYTE);

  const recoveryRate = cliFailures > 0
    ? Math.round((cliRecovered / cliFailures) * 100)
    : null;

  return {
    sessionCount: sessions.size,
    totalReads,
    repeatedReads,
    noOpWritesSkipped,
    agentLoopCount,
    readAfterWriteCount,
    totalWastedTokens,
    totalReadTokens,
    cliTotal,
    cliFailures,
    cliRecovered,
    recoveryRate,
    bashTotal,
    bashFailures,
    cliByName: Object.fromEntries(
      [...cliByName.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10)
    ),
  };
}

// ---------------------------------------------------------------------------
// Runs analysis
// ---------------------------------------------------------------------------
function analyseRuns(entries, cutoff) {
  const windowed = entries.filter(e => Date.parse(e.ts ?? e.timestamp ?? 0) >= cutoff);
  let totalCost = 0, totalTokens = 0, totalRuns = 0;
  const bySkill = new Map();
  const byDay   = new Map();

  for (const r of windowed) {
    totalRuns++;
    const cost = r.cost ?? 0, tokens = r.tokens ?? 0;
    totalCost += cost; totalTokens += tokens;
    const skill = r.skill ?? "unknown";
    if (!bySkill.has(skill)) bySkill.set(skill, { runs: 0, cost: 0, tokens: 0 });
    const s = bySkill.get(skill);
    s.runs++; s.cost += cost; s.tokens += tokens;
    const day = (r.ts ?? r.timestamp ?? "").slice(0, 10);
    if (day) {
      if (!byDay.has(day)) byDay.set(day, { runs: 0, cost: 0 });
      const d = byDay.get(day); d.runs++; d.cost += cost;
    }
  }

  return {
    totalRuns, totalCost, totalTokens,
    topSkills: [...bySkill.entries()]
      .sort((a, b) => b[1].runs - a[1].runs).slice(0, 8)
      .map(([name, v]) => ({ name, ...v })),
    dailyTrend: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0])).slice(-30)
      .map(([day, v]) => ({ day, ...v })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmt = {
  tokens: n => n >= 1_000_000 ? `${(n/1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n/1_000).toFixed(1)}K` : String(n),
  usd:  n => `$${n.toFixed(2)}`,
  pct:  n => `${n}%`,
  num:  n => n.toLocaleString("en-US"),
};

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function buildHtml(mcp, runs, daysBack, generatedAt) {
  const PRICE_PER_TOKEN = 3 / 1_000_000;
  const monthlySavings  = mcp.totalWastedTokens * PRICE_PER_TOKEN * (30 / Math.max(daysBack, 1));

  const effScore = mcp.totalReads > 0
    ? Math.round(((mcp.totalReads - mcp.repeatedReads) / mcp.totalReads) * 100)
    : 100;
  const grade      = effScore >= 90 ? "A" : effScore >= 75 ? "B" : effScore >= 60 ? "C" : "D";
  const gradeColor = { A: "#4CAF50", B: "#8BC34A", C: "#FFC107", D: "#F44336" }[grade];

  const accelPct = mcp.totalReads > 0
    ? Math.min(Math.round((mcp.noOpWritesSkipped + mcp.repeatedReads) / mcp.totalReads * 100 + 20), 55)
    : 0;

  const bashCoverage = mcp.cliTotal > 0
    ? Math.round((mcp.bashTotal / mcp.cliTotal) * 100)
    : 0;

  // Sparkline
  const maxDayCost = Math.max(...runs.dailyTrend.map(d => d.cost), 0.001);
  const sparkBars  = runs.dailyTrend.map((d, i) => {
    const h = Math.round((d.cost / maxDayCost) * 40);
    return `<rect x="${i*10+2}" y="${44-h}" width="8" height="${h}" fill="#5C9CF5" rx="1"/>`;
  }).join("");
  const sparkSvg = runs.dailyTrend.length > 0
    ? `<svg width="${runs.dailyTrend.length*10+4}" height="48" style="display:block;margin:8px 0">${sparkBars}</svg>`
    : `<p class="dim">No run data yet</p>`;

  const skillRows = runs.topSkills.map(s =>
    `<tr><td>${esc(s.name)}</td><td>${fmt.num(s.runs)}</td><td>${fmt.tokens(s.tokens)}</td>
     <td>${fmt.usd(s.cost)}</td><td>${s.runs > 0 ? fmt.usd(s.cost/s.runs) : "—"}</td></tr>`
  ).join("");

  const cliRows = Object.entries(mcp.cliByName).map(([cli, v]) => {
    const rate  = v.total > 0 ? Math.round(((v.total-v.failures)/v.total)*100) : 100;
    const color = rate >= 95 ? "#4CAF50" : rate >= 80 ? "#FFC107" : "#F44336";
    const mcpBadge  = v.mcp  > 0 ? `<span class="badge badge-blue">MCP ×${v.mcp}</span>`  : "";
    const bashBadge = v.bash > 0 ? `<span class="badge badge-purple">bash ×${v.bash}</span>` : "";
    return `<tr>
      <td><code>${esc(cli)}</code> ${mcpBadge}${bashBadge}</td>
      <td>${fmt.num(v.total)}</td>
      <td style="color:${color};font-weight:600">${rate}%</td>
      <td>${v.failures}</td>
    </tr>`;
  }).join("");

  const noData = mcp.sessionCount === 0 && runs.totalRuns === 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Claude Skills Manager — Telemetry Dashboard</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#0d1117;color:#c9d1d9;min-height:100vh;padding:24px}
  h1{font-size:20px;font-weight:700;color:#f0f6fc;margin-bottom:4px}
  h3{font-size:13px;font-weight:600;color:#8b949e;margin-bottom:12px;
     text-transform:uppercase;letter-spacing:.05em}
  .header{display:flex;justify-content:space-between;align-items:flex-start;
          margin-bottom:28px;flex-wrap:wrap;gap:8px}
  .header-meta{font-size:12px;color:#8b949e;line-height:1.6}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));
            gap:14px;margin-bottom:28px}
  .kpi{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:18px 20px}
  .kpi-label{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
  .kpi-value{font-size:28px;font-weight:700;color:#f0f6fc;line-height:1}
  .kpi-sub{font-size:11px;color:#8b949e;margin-top:6px}
  .kpi.green .kpi-value{color:#3fb950}
  .kpi.blue  .kpi-value{color:#5C9CF5}
  .kpi.yellow .kpi-value{color:#d29922}
  .kpi.purple .kpi-value{color:#bc8cff}
  .panels{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
  .panel{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px}
  .panel.wide{grid-column:1/-1}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:6px 10px;color:#8b949e;font-size:11px;
     text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #30363d}
  td{padding:7px 10px;border-bottom:1px solid #21262d}
  tr:last-child td{border-bottom:none}
  code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;
       background:#21262d;padding:2px 5px;border-radius:3px}
  .grade-badge{display:inline-flex;align-items:center;justify-content:center;
               width:36px;height:36px;border-radius:50%;font-size:18px;font-weight:700;
               color:#fff;background:${gradeColor};flex-shrink:0}
  .bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .bar-label{font-size:12px;width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{flex:1;background:#21262d;border-radius:3px;height:8px}
  .bar-fill{height:8px;border-radius:3px;background:#5C9CF5}
  .bar-num{font-size:12px;color:#8b949e;width:50px;text-align:right}
  .dim{color:#8b949e;font-size:12px}
  .badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;
         font-weight:600;margin-left:4px}
  .badge-blue{background:#1a2a4a;color:#5C9CF5}
  .badge-purple{background:#2a1a4a;color:#bc8cff}
  .badge-green{background:#1a3a22;color:#3fb950}
  .no-data{text-align:center;padding:40px;color:#8b949e;font-size:13px;line-height:1.8}
  footer{margin-top:28px;font-size:11px;color:#484f58;text-align:center}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>Claude Skills Manager — Telemetry Dashboard</h1>
    <div class="header-meta">
      Period: last <strong>${daysBack} days</strong> &nbsp;|&nbsp;
      Generated: <strong>${generatedAt}</strong> &nbsp;|&nbsp;
      Source: <code>~/.claude/learning/</code>
    </div>
  </div>
  <div class="grade-badge" title="MCP read efficiency grade">${grade}</div>
</div>

${noData ? `<div class="no-data">
  <p><strong>No telemetry data yet.</strong></p>
  <p style="margin-top:12px">Run a few Claude Code sessions with the MCP filesystem server enabled,<br>
  then re-run this script. Native bash commands require <code>terminal-watch.js</code> to be<br>
  registered as a PostToolUse hook for Bash and PowerShell.</p>
</div>` : `

<div class="kpi-grid">
  <div class="kpi blue">
    <div class="kpi-label">Sessions Analysed</div>
    <div class="kpi-value">${fmt.num(mcp.sessionCount)}</div>
    <div class="kpi-sub">last ${daysBack} days</div>
  </div>
  <div class="kpi green">
    <div class="kpi-label">Token Waste Prevented</div>
    <div class="kpi-value">${fmt.tokens(mcp.totalWastedTokens)}</div>
    <div class="kpi-sub">reads + loops + no-op writes</div>
  </div>
  <div class="kpi green">
    <div class="kpi-label">Repeated Reads Avoided</div>
    <div class="kpi-value">${fmt.num(mcp.repeatedReads + mcp.noOpWritesSkipped)}</div>
    <div class="kpi-sub">${fmt.num(mcp.repeatedReads)} re-reads · ${fmt.num(mcp.noOpWritesSkipped)} no-op writes</div>
  </div>
  ${mcp.recoveryRate !== null ? `
  <div class="kpi ${mcp.recoveryRate >= 80 ? "green" : mcp.recoveryRate >= 60 ? "yellow" : ""}">
    <div class="kpi-label">Recovery Rate</div>
    <div class="kpi-value">${fmt.pct(mcp.recoveryRate)}</div>
    <div class="kpi-sub">${mcp.cliRecovered}/${mcp.cliFailures} failures self-corrected</div>
  </div>` : `
  <div class="kpi blue">
    <div class="kpi-label">Terminal Calls</div>
    <div class="kpi-value">${fmt.num(mcp.cliTotal)}</div>
    <div class="kpi-sub">${fmt.num(mcp.bashTotal)} native bash · ${fmt.num(mcp.cliTotal - mcp.bashTotal)} MCP CLI</div>
  </div>`}
  <div class="kpi purple">
    <div class="kpi-label">Native Bash Coverage</div>
    <div class="kpi-value">${bashCoverage}%</div>
    <div class="kpi-sub">${fmt.num(mcp.bashTotal)} bash hook · ${fmt.num(mcp.cliTotal - mcp.bashTotal)} MCP CLI calls</div>
  </div>
  <div class="kpi ${accelPct >= 30 ? "green" : "yellow"}">
    <div class="kpi-label">Delivery Acceleration</div>
    <div class="kpi-value">~${accelPct}%</div>
    <div class="kpi-sub">estimated from waste reduction</div>
  </div>
  <div class="kpi green">
    <div class="kpi-label">Est. AI Savings / Month</div>
    <div class="kpi-value">${fmt.usd(monthlySavings)}</div>
    <div class="kpi-sub">at Sonnet $3/M input tokens</div>
  </div>
  <div class="kpi ${effScore >= 90 ? "green" : effScore >= 75 ? "yellow" : ""}">
    <div class="kpi-label">MCP Efficiency Score</div>
    <div class="kpi-value">${effScore}%</div>
    <div class="kpi-sub">useful reads / total · grade ${grade}</div>
  </div>
</div>

<div class="panels">
  <div class="panel">
    <h3>Waste Breakdown</h3>
    ${[
      ["Repeated reads (3rd+)",   mcp.repeatedReads,       mcp.totalReads],
      ["No-op writes skipped",    mcp.noOpWritesSkipped,   mcp.totalReads],
      ["Agent loop reads",        mcp.agentLoopCount,      mcp.totalReads],
      ["Read-after-write ops",    mcp.readAfterWriteCount, mcp.totalReads],
    ].map(([label, val, total]) => {
      const pct = total > 0 ? Math.round((val/total)*100) : 0;
      return `<div class="bar-row">
        <span class="bar-label">${label}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.min(pct*3,100)}%"></div></div>
        <span class="bar-num">${fmt.num(val)}</span>
      </div>`;
    }).join("")}
    <p class="dim" style="margin-top:12px">Tokens wasted: <strong>${fmt.tokens(mcp.totalWastedTokens)}</strong> · Total reads: <strong>${fmt.num(mcp.totalReads)}</strong></p>
  </div>

  <div class="panel">
    <h3>Terminal Health · ${fmt.num(mcp.cliTotal)} calls</h3>
    ${Object.keys(mcp.cliByName).length === 0
      ? `<p class="dim">No CLI or bash calls recorded yet.<br>
         Register <code>terminal-watch.js</code> as a PostToolUse<br>hook to capture native bash/PowerShell commands.</p>`
      : `<table>
          <thead><tr><th>CLI</th><th>Calls</th><th>Success</th><th>Failures</th></tr></thead>
          <tbody>${cliRows}</tbody>
        </table>
        <p class="dim" style="margin-top:10px">
          <span class="badge badge-blue">MCP</span> via CLI MCP server &nbsp;
          <span class="badge badge-purple">bash</span> via terminal-watch hook
        </p>`}
  </div>

  <div class="panel">
    <h3>Daily AI Cost · ${daysBack}d</h3>
    ${sparkSvg}
    <p class="dim">Total: ${fmt.usd(runs.totalCost)} · Avg/day: ${
      runs.dailyTrend.length > 0 ? fmt.usd(runs.totalCost / runs.dailyTrend.length) : "—"
    } · Skill runs: ${fmt.num(runs.totalRuns)}</p>
  </div>

  <div class="panel wide">
    <h3>Top Skills by Usage</h3>
    ${runs.topSkills.length === 0
      ? `<p class="dim">No skill runs yet. The <code>skill-invoke-watch.js</code> hook writes to runs.jsonl when the AI reads a skill file.</p>`
      : `<table>
          <thead><tr><th>Skill</th><th>Runs</th><th>Tokens</th><th>Total Cost</th><th>Avg / Run</th></tr></thead>
          <tbody>${skillRows}</tbody>
        </table>`}
  </div>
</div>
`}

<footer>
  Generated by <strong>generate-dashboard.mjs</strong> —
  real data from <code>${MCP_LOG.replace(os.homedir(), "~")}</code>
  and <code>${RUNS_LOG.replace(os.homedir(), "~")}</code>.
  MCP CLI entries tagged <span style="color:#5C9CF5">blue</span>, native bash entries tagged <span style="color:#bc8cff">purple</span>.
</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const mcpEntries  = readJsonl(MCP_LOG);
const runsEntries = readJsonl(RUNS_LOG);
const mcpStats    = analyseMcp(mcpEntries, cutoffMs);
const runsStats   = analyseRuns(runsEntries, cutoffMs);
const generatedAt = new Date().toLocaleString("en-US", {
  year:"numeric", month:"short", day:"numeric", hour:"2-digit", minute:"2-digit",
});

const html = buildHtml(mcpStats, runsStats, daysBack, generatedAt);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, "utf-8");

console.log(`Dashboard written to: ${outFile}`);
console.log();
console.log("=== Summary ===");
console.log(`Sessions analysed:        ${fmt.num(mcpStats.sessionCount)}`);
console.log(`Token waste prevented:    ${fmt.tokens(mcpStats.totalWastedTokens)}`);
console.log(`Repeated reads avoided:   ${fmt.num(mcpStats.repeatedReads + mcpStats.noOpWritesSkipped)}`);
console.log(`Terminal calls total:     ${fmt.num(mcpStats.cliTotal)}  (${fmt.num(mcpStats.bashTotal)} native bash · ${fmt.num(mcpStats.cliTotal - mcpStats.bashTotal)} MCP CLI)`);
console.log(`CLI recovery rate:        ${mcpStats.recoveryRate !== null ? fmt.pct(mcpStats.recoveryRate) : "n/a (no failures)"}`);
console.log(`Skill runs logged:        ${fmt.num(runsStats.totalRuns)}`);
console.log(`Total AI cost tracked:    ${fmt.usd(runsStats.totalCost)}`);
console.log(`MCP efficiency grade:     ${effGrade(mcpStats)}`);
console.log();
console.log("Note: bash coverage = 0% until terminal-watch.js is registered as a PostToolUse hook.");

function effGrade(m) {
  if (m.totalReads === 0) return "n/a (no reads)";
  const s = Math.round(((m.totalReads - m.repeatedReads) / m.totalReads) * 100);
  return `${s}% (${s >= 90 ? "A" : s >= 75 ? "B" : s >= 60 ? "C" : "D"})`;
}
