import { execFileSync, execSync } from "node:child_process";
import * as net from "node:net";
import * as tls from "node:tls";
import * as vscode from "vscode";
import { agentCapabilityLines, computeEnabledAgentsCreditUsage } from "./agentOps";
import { buildCostAttribution, resolveDisplayAttribution } from "./costAttribution";
import { calculateTrend, predictWeeklyCostFromTrend } from "./costPredictor";
import { generateOptimizationSuggestions } from "./costOptimizer";
import { runCostPipelineSync } from "./costPipeline";
import { assessAttributionHealth } from "./attributionQuality";
import { formatConfidenceBadge } from "./attributionQuality";
import { fetchVcsIdentity, parseGitRemote, pickAndStoreVcsToken } from "./vcsReportDelivery";
import { formatCompactUsd } from "./skillCost";
import { loadManifest } from "./skillOps";
import { readSkillStatsIndex } from "./runsStore";
import { isUsageRunRecord } from "./runsStore";
import {
  enrichUsageStatsWithAttribution,
  formatCrossAgentUsageBrief,
  formatTokenCount,
  readEnrichedRuns,
} from "./usageStats";
import { formatWeeklyBenefitsLines } from "./weeklyReportBenefits";

export interface WeeklyReportConfig {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  emailTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  emailSubject: string;
}

const SECRET_SMTP_HOST = "claudeSkills.weeklyReport.smtpHost";
const SECRET_SMTP_PORT = "claudeSkills.weeklyReport.smtpPort";
const SECRET_SMTP_USER = "claudeSkills.weeklyReport.smtpUser";
const SECRET_SMTP_PASSWORD = "claudeSkills.weeklyReport.smtpPassword";
const SECRET_REPORT_EMAIL = "claudeSkills.weeklyReport.recipientEmail";

export interface WeeklyReportSummary {
  body: string;
  thisWeekUsd: number;
  lastWeekUsd: number;
  changePercent: number;
  totalTokens: number;
}

const LAST_SENT_KEY = "claudeSkills.lastWeeklyReportWeek";

export function readWeeklyReportConfig(): WeeklyReportConfig {
  const cfg = vscode.workspace.getConfiguration("claudeSkills.weeklyReport");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    dayOfWeek: cfg.get<number>("dayOfWeek", 1),
    hour: cfg.get<number>("hour", 9),
    minute: cfg.get<number>("minute", 0),
    emailTo:
      cfg.get<string>("emailTo", "") ||
      process.env.CLAUDE_SKILLS_REPORT_TO ||
      process.env.CLAUDE_SKILLS_EMAIL_TO ||
      "",
    smtpHost: cfg.get<string>("smtpHost", "") || process.env.CLAUDE_SKILLS_SMTP_HOST || "",
    smtpPort: cfg.get<number>("smtpPort", 587) || Number(process.env.CLAUDE_SKILLS_SMTP_PORT || 587),
    smtpUser: cfg.get<string>("smtpUser", "") || process.env.CLAUDE_SKILLS_SMTP_USER || "",
    smtpPassword: process.env.CLAUDE_SKILLS_SMTP_PASSWORD || "",
    emailSubject:
      cfg.get<string>("emailSubject", "") ||
      cfg.get<string>("issueTitle", "Weekly Claude Skills Benefits Report"),
  };
}

export async function loadWeeklyReportSecrets(
  context: vscode.ExtensionContext,
  base: WeeklyReportConfig = readWeeklyReportConfig()
): Promise<WeeklyReportConfig> {
  const [host, port, user, password, recipient] = await Promise.all([
    context.secrets.get(SECRET_SMTP_HOST),
    context.secrets.get(SECRET_SMTP_PORT),
    context.secrets.get(SECRET_SMTP_USER),
    context.secrets.get(SECRET_SMTP_PASSWORD),
    context.secrets.get(SECRET_REPORT_EMAIL),
  ]);
  return {
    ...base,
    emailTo: recipient || base.emailTo,
    smtpHost: host || base.smtpHost,
    smtpPort: port ? Number(port) : base.smtpPort,
    smtpUser: user || base.smtpUser,
    smtpPassword: password || base.smtpPassword,
  };
}

export async function storeSmtpSecrets(
  context: vscode.ExtensionContext,
  smtp: { host: string; port: number; user: string; password: string },
  recipientEmail: string
): Promise<void> {
  await Promise.all([
    context.secrets.store(SECRET_SMTP_HOST, smtp.host),
    context.secrets.store(SECRET_SMTP_PORT, String(smtp.port)),
    context.secrets.store(SECRET_SMTP_USER, smtp.user),
    context.secrets.store(SECRET_SMTP_PASSWORD, smtp.password),
    context.secrets.store(SECRET_REPORT_EMAIL, recipientEmail),
  ]);
}

export async function clearWeeklyReportSecrets(context: vscode.ExtensionContext): Promise<void> {
  for (const key of [
    SECRET_SMTP_HOST,
    SECRET_SMTP_PORT,
    SECRET_SMTP_USER,
    SECRET_SMTP_PASSWORD,
    SECRET_REPORT_EMAIL,
  ]) {
    await context.secrets.delete(key);
  }
}

function ghExec(args: string[], cwd: string): string {
  try {
    return execFileSync("gh", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch {
    throw new Error("GitHub CLI command failed");
  }
}

export function safeDeliveryError(err: unknown): string {
  const msg = (err as Error).message ?? "delivery failed";
  if (/password|secret|token|smtp|auth/i.test(msg)) {
    return "email delivery failed (check SMTP settings)";
  }
  return msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
}

function gitConfigEmail(cwd: string): string | undefined {
  try {
    const email = execSync("git config user.email", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/** GitHub noreply addresses cannot receive mail — common as git config user.email. */
export function isNoreplyEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email) || /noreply/i.test(email.split("@")[0] ?? "");
}

export function ghPrimaryEmail(cwd: string): string | undefined {
  try {
    const emails = JSON.parse(ghExec(["api", "user/emails"], cwd)) as { email: string; primary?: boolean }[];
    const primary = emails.find((e) => e.primary)?.email ?? emails[0]?.email;
    if (primary && !isNoreplyEmail(primary)) {
      return primary;
    }
  } catch {
    // needs: gh auth refresh -h github.com -s user,read:user
  }
  try {
    const email = ghExec(["api", "user", "-q", ".email"], cwd);
    if (email && !isNoreplyEmail(email)) {
      return email;
    }
  } catch {
    // ignore
  }
  const gitEmail = gitConfigEmail(cwd);
  if (gitEmail && !isNoreplyEmail(gitEmail)) {
    return gitEmail;
  }
  return undefined;
}

/** Resolve recipient: stored secret â†’ settings â†’ GitHub/GitLab API â†’ gh CLI â†’ git config. */
export async function resolveReportRecipient(
  context: vscode.ExtensionContext,
  target: string,
  config: WeeklyReportConfig
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (config.emailTo?.trim()) {
    candidates.push(config.emailTo.trim());
  }

  const remote = parseGitRemote(target);
  if (remote) {
    const auth = await fetchVcsIdentity(context, remote);
    if ("identity" in auth && auth.identity.email) {
      candidates.push(auth.identity.email);
    }
  }

  const ghEmail = ghPrimaryEmail(target);
  if (ghEmail) {
    candidates.push(ghEmail);
  }
  const gitEmail = gitConfigEmail(target);
  if (gitEmail) {
    candidates.push(gitEmail);
  }

  for (const email of candidates) {
    if (!isNoreplyEmail(email)) {
      return email;
    }
  }
  return undefined;
}

function isoWeekKey(d: Date): string {
  const copy = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  copy.setUTCDate(copy.getUTCDate() + 4 - (copy.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function shouldSendScheduledReport(config: WeeklyReportConfig, lastSentWeek: string | undefined): boolean {
  if (!config.enabled) {
    return false;
  }
  const now = new Date();
  if (now.getDay() !== config.dayOfWeek) {
    return false;
  }
  if (now.getHours() < config.hour || (now.getHours() === config.hour && now.getMinutes() < config.minute)) {
    return false;
  }
  return isoWeekKey(now) !== lastSentWeek;
}

function weekCostFromRuns(target: string, daysBack: number): { cost: number; tokens: number } {
  const cutoff = Date.now() - daysBack * 86_400_000;
  let cost = 0;
  let tokens = 0;
  for (const run of readEnrichedRuns(target)) {
    if (!isUsageRunRecord(run)) {
      continue;
    }
    if (new Date(run.ts).getTime() >= cutoff) {
      cost += run.cost;
      tokens += run.tokens;
    }
  }
  return { cost, tokens };
}

export function buildWeeklyReportSummary(target: string, libraryDir: string): WeeklyReportSummary {
  const thisWeek = weekCostFromRuns(target, 7);
  const lastWeek = weekCostFromRuns(target, 14);
  const priorWeekCost = Math.max(0, lastWeek.cost - thisWeek.cost);
  const changePercent = priorWeekCost > 0 ? ((thisWeek.cost - priorWeekCost) / priorWeekCost) * 100 : 0;

  const trend = calculateTrend(target, libraryDir);
  const credit = computeEnabledAgentsCreditUsage(libraryDir, 14, target);
  const health = assessAttributionHealth(target, libraryDir);
  runCostPipelineSync(target, libraryDir);
  const built = buildCostAttribution(target, libraryDir);
  const { attribution } = resolveDisplayAttribution(built, target);
  const manifest = loadManifest(libraryDir);
  const usageStats = enrichUsageStatsWithAttribution(readSkillStatsIndex(target, manifest), attribution);
  const crossAgentLines = formatCrossAgentUsageBrief(usageStats);
  const suggestions = generateOptimizationSuggestions(target, libraryDir).slice(0, 5);
  const benefitsLines = formatWeeklyBenefitsLines(target, attribution, usageStats, suggestions);

  const agentLines: string[] = [];
  for (const [agent, stats] of Object.entries(built.agentTotals).sort()) {
    if (stats) {
      agentLines.push(`- **${agent}**: ${formatTokenCount(stats.tokens)} tokens, ~${formatCompactUsd(stats.cost)} (${stats.sessions} sessions, 14d transcripts)`);
    }
  }
  if (agentLines.length === 0 && credit.totalTokens > 0) {
    agentLines.push(`- **all enabled agents**: ${formatTokenCount(credit.totalTokens)} tokens, ~${formatCompactUsd(credit.totalCost)} (14d)`);
  }

  const topSkills = Object.entries({ ...built.skills, ...built.transcriptSkills })
    .filter(([name]) => name !== "unattributed" && name !== "base_context")
    .map(([name, agents]) => ({
      name,
      cost: Object.values(agents ?? {}).reduce((s, a) => s + (a?.cost ?? 0), 0),
    }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  const lines = [
    "## Weekly Claude Skills report",
    "",
    `**Workspace:** \`${target}\``,
    `**Week ending:** ${new Date().toISOString().slice(0, 10)}`,
    "",
    ...benefitsLines,
    "## AI usage & spend",
    "",
    "### This week (runs.jsonl)",
    `- Estimated spend: **${formatCompactUsd(thisWeek.cost)}**`,
    `- Tokens recorded: **${formatTokenCount(thisWeek.tokens)}**`,
    `- Change vs prior week: **${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}%**`,
    `- Trend (transcripts): ${trend.direction === "up" ? "up" : trend.direction === "down" ? "down" : "flat"} ${Math.abs(trend.percentage)}%${trend.reliable ? "" : " (insufficient prior week)"}`,
    `- Projected next week: ~${formatCompactUsd(predictWeeklyCostFromTrend(trend))}`,
    `- Attribution confidence: ${Math.round(health.confidenceScore * 100)}% (${formatConfidenceBadge(health.confidenceLevel)})`,
    "",
    "### Agent totals (session transcripts, 14 days)",
    agentLines.length ? agentLines.join("\n") : "- No transcript usage yet",
    "",
    ...(crossAgentLines.length > 0 ? crossAgentLines : []),
    "### Enabled agents",
    ...agentCapabilityLines(libraryDir),
    "",
    "### Top skills by attributed cost",
    topSkills.length
      ? topSkills.map((s) => `- ${s.name}: ~${formatCompactUsd(s.cost)}`).join("\n")
      : "- No per-skill attribution yet",
    "",
  ];

  const unattributed = Object.values(built.unattributed).reduce((s, t) => s + (t ?? 0), 0);
  if (unattributed > 0) {
    lines.push(`### Unattributed tokens`, `- ${formatTokenCount(unattributed)} (no invoked skill detected in transcripts)`, "");
  }

  lines.push(
    "---",
    "_Sent by Claude Skills Manager. Benefits and spend are estimated from .claude/learning/runs.jsonl, project-profile.json, and session transcripts — not your Anthropic/Cursor invoice. Open **Claude Skills: Show Cost Intelligence Dashboard** for details._"
  );

  return {
    body: lines.join("\n"),
    thisWeekUsd: thisWeek.cost,
    lastWeekUsd: priorWeekCost,
    changePercent,
    totalTokens: thisWeek.tokens,
  };
}

function smtpSession(
  socket: net.Socket | tls.TLSSocket,
  smtpHost: string,
  user: string,
  password: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let step = 0;
    let buffer = "";
    const send = (cmd: string) => socket.write(`${cmd}\r\n`);

    const fail = (text: string) => reject(new Error(text.trim()));

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) {
          continue;
        }
        const code = line.slice(0, 3);
        if (code.startsWith("4") || code.startsWith("5")) {
          fail(line);
          return;
        }
        if (step === 0 && code === "220") {
          send("EHLO localhost");
          step = 1;
        } else if (step === 1 && code === "250" && line[3] === " ") {
          // line[3] === " " identifies the terminal line of a multi-line EHLO response
          // (RFC 5321: continuation lines use "250-", final line uses "250 ").
          if (socket instanceof net.Socket && !(socket as tls.TLSSocket).encrypted) {
            send("STARTTLS");
            step = 2;
          } else {
            send("AUTH LOGIN");
            step = 4;
          }
        } else if (step === 2 && code === "220") {
          const upgraded = tls.connect({ socket, servername: smtpHost }, () => {
            step = 3;
            send("EHLO localhost");
          });
          upgraded.on("error", reject);
          socket.removeAllListeners("data");
          socket.removeAllListeners("error");
          smtpSession(upgraded, smtpHost, user, password, to, subject, body).then(resolve).catch(reject);
          return;
        } else if (step === 3 && code === "250" && line[3] === " ") {
          send("AUTH LOGIN");
          step = 4;
        } else if (step === 4 && code === "334") {
          send(Buffer.from(user).toString("base64"));
          step = 5;
        } else if (step === 5 && code === "334") {
          send(Buffer.from(password).toString("base64"));
          step = 6;
        } else if (step === 6 && code === "235") {
          send(`MAIL FROM:<${user}>`);
          step = 7;
        } else if (step === 7 && code === "250") {
          send(`RCPT TO:<${to}>`);
          step = 8;
        } else if (step === 8 && code === "250") {
          send("DATA");
          step = 9;
        } else if (step === 9 && code === "354") {
          const dateStr = new Date().toUTCString();
          socket.write(
            `Subject: ${subject}\r\nFrom: ${user}\r\nTo: ${to}\r\nDate: ${dateStr}\r\n` +
            `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`
          );
          step = 10;
        } else if (step === 10 && code === "250") {
          send("QUIT");
          socket.end();
          resolve();
        }
      }
    });
    socket.on("error", reject);
  });
}

function sendSmtpEmail(
  host: string,
  port: number,
  user: string,
  password: string,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (port === 465) {
      const secure = tls.connect(port, host, { servername: host }, () => {
        smtpSession(secure, host, user, password, to, subject, body).then(resolve).catch(reject);
      });
      secure.on("error", reject);
      return;
    }
    const socket = net.connect(port, host, () => {
      smtpSession(socket, host, user, password, to, subject, body).then(resolve).catch(reject);
    });
    socket.on("error", reject);
  });
}

export async function sendWeeklyReportEmail(
  context: vscode.ExtensionContext,
  target: string,
  config: WeeklyReportConfig,
  subject: string,
  body: string
): Promise<{ ok: boolean; to?: string; error?: string }> {
  const to = await resolveReportRecipient(context, target, config);
  const gitEmail = gitConfigEmail(target);
  if (!to) {
    const noreplyHint =
      gitEmail && isNoreplyEmail(gitEmail)
        ? ` Git config has noreply address (${gitEmail}) which cannot receive mail.`
        : "";
    return {
      ok: false,
      error:
        `No receivable email found.${noreplyHint} Run Configure Weekly Report Email (GitHub/GitLab token with user:email scope) or set claudeSkills.weeklyReport.emailTo.`,
    };
  }
  if (!config.smtpHost || !config.smtpUser || !config.smtpPassword) {
    return {
      ok: false,
      error:
        "SMTP not configured. Run Configure Weekly Report Email once (Gmail app password or company SMTP). GitHub/GitLab tokens identify your address but cannot send mail.",
    };
  }
  try {
    await sendSmtpEmail(config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPassword, to, subject, body);
    return { ok: true, to };
  } catch (err) {
    return { ok: false, error: safeDeliveryError(err) };
  }
}

export interface WeeklyReportResult {
  email: { ok: boolean; to?: string; error?: string };
}

export async function deliverWeeklyReport(
  context: vscode.ExtensionContext,
  target: string,
  libraryDir: string,
  config?: WeeklyReportConfig
): Promise<WeeklyReportResult> {
  const effective = config ?? (await loadWeeklyReportSecrets(context));
  const summary = buildWeeklyReportSummary(target, libraryDir);
  const plainSubject = `${effective.emailSubject} — ${formatCompactUsd(summary.thisWeekUsd)}`;
  const email = await sendWeeklyReportEmail(
    context,
    target,
    effective,
    plainSubject,
    summary.body.replace(/\*\*/g, "")
  );
  return { email };
}

async function pickSmtpPreset(): Promise<{ host: string; port: number; hint: string } | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Gmail", description: "smtp.gmail.com:587 — needs Google app password", preset: "gmail" },
      { label: "Microsoft 365 / Outlook", description: "smtp.office365.com:587", preset: "m365" },
      { label: "Custom SMTP", description: "Enter host, port, username, password", preset: "custom" },
    ],
    { title: "Weekly report — mail server", placeHolder: "SMTP sends the informative usage email (token only finds your address)." }
  );
  if (!pick) {
    return undefined;
  }
  const preset = (pick as { preset?: string }).preset;
  if (preset === "gmail") {
    return { host: "smtp.gmail.com", port: 587, hint: "Use a Google app password (not your login password)." };
  }
  if (preset === "m365") {
    return { host: "smtp.office365.com", port: 587, hint: "Use your work Microsoft account credentials." };
  }
  const host = await vscode.window.showInputBox({
    title: "SMTP host",
    value: "",
    ignoreFocusOut: true,
  });
  if (!host?.trim()) {
    return undefined;
  }
  const portStr = await vscode.window.showInputBox({
    title: "SMTP port",
    value: "587",
    ignoreFocusOut: true,
  });
  const port = Number(portStr || "587");
  return { host: host.trim(), port: Number.isFinite(port) ? port : 587, hint: "" };
}

/** One-time wizard: git token â†’ your email, SMTP â†’ send informative weekly usage mail. */
export async function configureWeeklyReportEmail(
  context: vscode.ExtensionContext,
  target: string | undefined
): Promise<string> {
  if (!target) {
    return "Open a workspace folder first.";
  }
  const remote = parseGitRemote(target);
  if (!remote) {
    return "No GitHub/GitLab origin remote found. Add git remote add origin ... first.";
  }

  const action = await vscode.window.showQuickPick(
    [
      { label: "Set up or update email delivery", id: "setup" },
      { label: "Clear stored email settings", id: "clear" },
    ],
    { title: "Weekly AI usage report — email only" }
  );
  if (!action) {
    return "Cancelled.";
  }
  if (action.id === "clear") {
    await clearWeeklyReportSecrets(context);
    return "Cleared stored recipient and SMTP credentials.";
  }

  const tokenResult = await pickAndStoreVcsToken(context, remote);
  if ("error" in tokenResult) {
    return tokenResult.error;
  }
  const { identity } = tokenResult;

  let recipient = identity.email;
  if (recipient) {
    const useDiscovered = await vscode.window.showQuickPick(
      [
        { label: `Send to ${recipient}`, id: "yes" },
        { label: "Enter a different email address", id: "other" },
      ],
      { title: "Weekly report recipient" }
    );
    if (!useDiscovered) {
      return "Cancelled.";
    }
    if (useDiscovered.id === "other") {
      recipient = undefined;
    }
  }

  if (!recipient) {
    const manual = await vscode.window.showInputBox({
      title: "Email address for weekly AI usage reports",
      prompt: identity.email
        ? `Token could not read a private email for @${identity.username}. Enter your inbox.`
        : `Enter the inbox linked to @${identity.username}.`,
      value: identity.email ?? "",
      ignoreFocusOut: true,
    });
    if (!manual?.trim() || isNoreplyEmail(manual.trim())) {
      return "A real inbox address is required (not a noreply.github.com address).";
    }
    recipient = manual.trim();
  }

  const smtpPreset = await pickSmtpPreset();
  if (!smtpPreset) {
    return "Cancelled.";
  }

  const smtpUser = await vscode.window.showInputBox({
    title: "SMTP username (usually your email)",
    value: recipient,
    prompt: smtpPreset.hint,
    ignoreFocusOut: true,
  });
  if (!smtpUser?.trim()) {
    return "Cancelled.";
  }

  const smtpPassword = await vscode.window.showInputBox({
    title: "SMTP password",
    prompt: smtpPreset.hint || "App password or SMTP secret",
    password: true,
    ignoreFocusOut: true,
  });
  if (!smtpPassword) {
    return "Cancelled.";
  }

  await storeSmtpSecrets(
    context,
    { host: smtpPreset.host, port: smtpPreset.port, user: smtpUser.trim(), password: smtpPassword },
    recipient
  );

  const test = await vscode.window.showQuickPick(
    [
      { label: "Send test email now", id: "test" },
      { label: "Skip test", id: "skip" },
    ],
    { title: "Verify delivery" }
  );

  const lines = [
    `Weekly AI usage email configured for ${recipient}.`,
    `Git account: @${identity.username} (${remote.provider})`,
    `SMTP: ${smtpUser.trim()} via ${smtpPreset.host}:${smtpPreset.port}`,
    "",
    "Each Monday (or manual send) delivers an informative email — no GitHub/GitLab issues.",
  ];

  if (test?.id === "test") {
    const cfg = await loadWeeklyReportSecrets(context);
    const send = await sendWeeklyReportEmail(
      context,
      target,
      cfg,
      "Claude Skills — test weekly AI usage email",
      [
        "This is a test message from Claude Skills Manager.",
        "",
        `Recipient: ${recipient}`,
        `Git account: @${identity.username}`,
        "",
        "If you received this, weekly AI usage reports are configured correctly.",
      ].join("\n")
    );
    if (send.ok) {
      lines.push("", `Test email sent to ${send.to}.`);
    } else {
      lines.push("", `Test failed: ${send.error}`);
    }
  }

  return lines.join("\n");
}

export async function runScheduledWeeklyReport(
  context: vscode.ExtensionContext,
  target: string | undefined,
  libraryDir: string,
  log: (line: string) => void
): Promise<void> {
  if (!target) {
    return;
  }
  const config = readWeeklyReportConfig();
  const lastSent = context.globalState.get<string>(LAST_SENT_KEY);
  if (!shouldSendScheduledReport(config, lastSent)) {
    return;
  }

  const result = await deliverWeeklyReport(context, target, libraryDir);
  const weekKey = isoWeekKey(new Date());

  if (result.email.ok) {
    await context.globalState.update(LAST_SENT_KEY, weekKey);
    log(`Weekly report emailed to ${result.email.to}`);
    void vscode.window.showInformationMessage(
      `Claude Skills: weekly AI usage report emailed to ${result.email.to}.`
    );
  } else {
    const reason = result.email.error ?? "delivery failed";
    log(`Weekly report not sent: ${reason}`);
    void vscode.window.showWarningMessage(`Claude Skills: weekly report not sent — ${reason}`);
  }
}

export function startWeeklyReportScheduler(
  context: vscode.ExtensionContext,
  getTarget: () => string | undefined,
  libraryDir: string,
  log: (line: string) => void
): void {
  const tick = () => {
    const target = getTarget();
    if (target) {
      void runScheduledWeeklyReport(context, target, libraryDir, log);
    }
  };
  tick();
  const timer = setInterval(tick, 15 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
