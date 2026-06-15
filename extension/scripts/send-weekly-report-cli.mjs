/**
 * Headless weekly benefits report — preview or send via SMTP env vars.
 *
 * Usage (from extension/):
 *   npm run compile
 *   npm run send-weekly-report -- [workspaceDir]
 *
 * Env:
 *   CLAUDE_SKILLS_EMAIL_TO          recipient (required to send)
 *   CLAUDE_SKILLS_SMTP_HOST         e.g. smtp.mail.yahoo.com
 *   CLAUDE_SKILLS_SMTP_PORT         default 587 (try 465 if 587 is blocked)
 *   CLAUDE_SKILLS_SMTP_TRY_465      if 587 fails, retry implicit TLS on 465
 *   CLAUDE_SKILLS_SMTP_CONNECT_MS  TCP connect timeout (default 20000)
 *   CLAUDE_SKILLS_SMTP_CHECK=1      test TCP to SMTP host/port only
 *   CLAUDE_SKILLS_SMTP_USER         usually same as inbox
 *   CLAUDE_SKILLS_SMTP_PASSWORD     mail app password (NOT a GitHub PAT)
 *   CLAUDE_SKILLS_REPORT_PREVIEW=1  print body only, do not send
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLibraryDir } from "./resolve-library-dir.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "..");
const workspaceDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(extensionDir, "..");
const libraryDir = resolveLibraryDir(extensionDir);

function loadModule(rel) {
  return import(pathToFileURL(path.join(extensionDir, "out", rel)).href);
}

function smtpSession(socket, smtpHost, user, password, to, subject, body) {
  return new Promise((resolve, reject) => {
    let step = 0;
    let buffer = "";
    const send = (cmd) => socket.write(`${cmd}\r\n`);
    const fail = (text) => reject(new Error(text.trim()));

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
        } else if (step === 1 && code === "250" && line.includes("localhost")) {
          if (socket instanceof net.Socket && !socket.encrypted) {
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
        } else if (step === 3 && code === "250" && line.includes("localhost")) {
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
          socket.write(`Subject: ${subject}\r\nFrom: ${user}\r\nTo: ${to}\r\n\r\n${body}\r\n.\r\n`);
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

function connectTimeoutMs() {
  const raw = Number(process.env.CLAUDE_SKILLS_SMTP_CONNECT_MS || "20000");
  return Number.isFinite(raw) && raw > 0 ? raw : 20000;
}

function formatSmtpError(err, host, port) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
    return (
      `${msg}\n` +
      `Cannot reach ${host}:${port}. Outbound SMTP is often blocked on port 587 by ISP, VPN, or corporate firewall.\n` +
      "Try:\n" +
      "  1. CLAUDE_SKILLS_SMTP_PORT=465 (Yahoo implicit TLS)\n" +
      "  2. CLAUDE_SKILLS_SMTP_TRY_465=1 (auto-retry 465 after 587 fails)\n" +
      "  3. Different network (phone hotspot, VPN off)\n" +
      "  4. Gmail/Outlook SMTP if you have an app password there\n" +
      "  5. CLAUDE_SKILLS_SMTP_CHECK=1 to test TCP only"
    );
  }
  return msg;
}

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function sendSmtpEmail(host, port, user, password, to, subject, body) {
  const timeoutMs = connectTimeoutMs();
  return new Promise((resolve, reject) => {
    if (port === 465) {
      const secure = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
        smtpSession(secure, host, user, password, to, subject, body).then(resolve).catch(reject);
      });
      secure.setTimeout(timeoutMs, () => {
        secure.destroy();
        reject(new Error(`connect ETIMEDOUT ${host}:${port}`));
      });
      secure.on("error", reject);
      return;
    }
    const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
      smtpSession(socket, host, user, password, to, subject, body).then(resolve).catch(reject);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`connect ETIMEDOUT ${host}:${port}`));
    });
    socket.on("error", reject);
  });
}

async function sendWithOptional465Fallback(host, primaryPort, user, password, to, subject, body) {
  try {
    await sendSmtpEmail(host, primaryPort, user, password, to, subject, body);
    return primaryPort;
  } catch (err) {
    const try465 = process.env.CLAUDE_SKILLS_SMTP_TRY_465 === "1" || primaryPort === 587;
    if (!try465 || primaryPort === 465) {
      throw err;
    }
    console.warn(`Port ${primaryPort} failed (${err instanceof Error ? err.message : err}); retrying ${host}:465 ...`);
    await sendSmtpEmail(host, 465, user, password, to, subject, body);
    return 465;
  }
}

async function main() {
  const host = process.env.CLAUDE_SKILLS_SMTP_HOST?.trim();
  const port = Number(process.env.CLAUDE_SKILLS_SMTP_PORT || "587");

  if (process.env.CLAUDE_SKILLS_SMTP_CHECK === "1") {
    if (!host) {
      console.error("Set CLAUDE_SKILLS_SMTP_HOST for SMTP check.");
      process.exit(1);
    }
    const timeoutMs = connectTimeoutMs();
    for (const p of [port, ...(port === 587 ? [465] : [])]) {
      const ok = await checkTcp(host, p, timeoutMs);
      console.log(`${host}:${p} — ${ok ? "REACHABLE" : "BLOCKED or TIMEOUT"}`);
    }
    return;
  }

  const { buildWeeklyReportSummary } = await loadModule("weeklyReport.js");
  const { formatCompactUsd } = await loadModule("skillCost.js");

  if (!fs.existsSync(path.join(workspaceDir, ".claude"))) {
    console.error(`Workspace not found or missing .claude/: ${workspaceDir}`);
    process.exit(1);
  }

  const summary = buildWeeklyReportSummary(workspaceDir, libraryDir);
  const plainBody = summary.body.replace(/\*\*/g, "");
  const subject = `Weekly Claude Skills Benefits Report — ${formatCompactUsd(summary.thisWeekUsd)}`;

  if (process.env.CLAUDE_SKILLS_REPORT_PREVIEW === "1") {
    console.log(plainBody);
    return;
  }

  const to = process.env.CLAUDE_SKILLS_EMAIL_TO?.trim();
  const user = process.env.CLAUDE_SKILLS_SMTP_USER?.trim();
  const password = process.env.CLAUDE_SKILLS_SMTP_PASSWORD;

  if (!to || !host || !user || !password) {
    console.error(
      "Missing SMTP env. GitHub PAT cannot send mail — set:\n" +
        "  CLAUDE_SKILLS_EMAIL_TO, CLAUDE_SKILLS_SMTP_HOST, CLAUDE_SKILLS_SMTP_USER, CLAUDE_SKILLS_SMTP_PASSWORD\n" +
        "Yahoo: smtp.mail.yahoo.com — try port 465 if 587 times out (ISP firewall).\n" +
        "Preview only: CLAUDE_SKILLS_REPORT_PREVIEW=1 npm run send-weekly-report"
    );
    process.exit(1);
  }

  try {
    const usedPort = await sendWithOptional465Fallback(host, port, user, password, to, subject, plainBody);
    console.log(`Sent weekly report to ${to} via ${host}:${usedPort}`);
  } catch (err) {
    console.error(`Send failed: ${formatSmtpError(err, host, port)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
