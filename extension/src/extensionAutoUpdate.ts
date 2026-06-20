import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { notifyBackground } from "./userNotify";

const OPEN_VSX_BASE = "https://open-vsx.org";
const LAST_INSTALLED_KEY = "claudeSkills.lastAutoUpdatedVersion";
const LAST_CHECK_KEY = "claudeSkills.lastExtensionUpdateCheckMs";

function integrationTestMode(): boolean {
  return process.env.CLAUDE_SKILLS_INTEGRATION_TEST === "1";
}

export interface OpenVsxLatest {
  version: string;
  downloadUrl: string;
}

export function parseVersionParts(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const match = /^(\d+)/.exec(part);
      return match ? Number.parseInt(match[1], 10) : 0;
    });
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersionParts(latest);
  const b = parseVersionParts(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return false;
}

export function extensionAutoUpdateEnabled(): boolean {
  return vscode.workspace.getConfiguration("claudeSkills").get<boolean>("autoUpdateExtension", true);
}

export function extensionAutoUpdateIntervalMs(): number {
  const hours = vscode.workspace.getConfiguration("claudeSkills").get<number>("autoUpdateExtensionHours", 6);
  const clamped = Math.min(168, Math.max(1, hours));
  return clamped * 60 * 60 * 1000;
}

export function shouldRunExtensionAutoUpdate(context: vscode.ExtensionContext): boolean {
  if (integrationTestMode()) {
    return false;
  }
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    return false;
  }
  if (!extensionAutoUpdateEnabled()) {
    return false;
  }
  return true;
}

export async function fetchLatestFromOpenVsx(
  publisher: string,
  name: string
): Promise<OpenVsxLatest | undefined> {
  const url = `${OPEN_VSX_BASE}/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "claude-skill-deployer-auto-update" },
  });
  if (!res.ok) {
    return undefined;
  }
  const body = (await res.json()) as { version?: string; files?: { download?: string } };
  if (!body.version || !body.files?.download) {
    return undefined;
  }
  const downloadPath = body.files.download.startsWith("http")
    ? body.files.download
    : `${OPEN_VSX_BASE}${body.files.download}`;
  return { version: body.version, downloadUrl: downloadPath };
}

async function downloadVsixToTemp(downloadUrl: string): Promise<string> {
  const res = await fetch(downloadUrl, {
    headers: { "User-Agent": "claude-skill-deployer-auto-update" },
  });
  if (!res.ok) {
    throw new Error(`VSIX download failed: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `claude-skills-${Date.now()}.vsix`);
  fs.writeFileSync(tmp, bytes);
  return tmp;
}

async function installFromGallery(extensionId: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand("workbench.extensions.installExtension", extensionId);
    return true;
  } catch {
    return false;
  }
}

async function installFromVsix(downloadUrl: string): Promise<boolean> {
  let tmp: string | undefined;
  try {
    tmp = await downloadVsixToTemp(downloadUrl);
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(tmp));
    return true;
  } catch {
    return false;
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export async function checkAndInstallExtensionUpdate(
  context: vscode.ExtensionContext,
  log: (line: string) => void
): Promise<boolean> {
  if (!shouldRunExtensionAutoUpdate(context)) {
    return false;
  }

  const manifest = context.extension.packageJSON as { name: string; publisher: string; version: string };
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const current = manifest.version;

  const latest = await fetchLatestFromOpenVsx(manifest.publisher, manifest.name);
  if (!latest || !isNewerVersion(latest.version, current)) {
    return false;
  }

  const lastInstalled = context.globalState.get<string>(LAST_INSTALLED_KEY);
  if (lastInstalled === latest.version) {
    return false;
  }

  void vscode.commands.executeCommand("workbench.extensions.action.checkForUpdates");

  const fromGallery = await installFromGallery(extensionId);
  const installed = fromGallery || (await installFromVsix(latest.downloadUrl));
  if (!installed) {
    return false;
  }

  await context.globalState.update(LAST_INSTALLED_KEY, latest.version);
  notifyBackground(
    `Extension updated ${current} -> ${latest.version}. Reload the window when convenient to activate.`,
    log
  );
  return true;
}

let updateInFlight = false;
let updateTimer: ReturnType<typeof setInterval> | undefined;

async function runScheduledCheck(context: vscode.ExtensionContext, log: (line: string) => void): Promise<void> {
  if (updateInFlight) {
    return;
  }
  const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
  if (Date.now() - lastCheck < extensionAutoUpdateIntervalMs()) {
    return;
  }
  updateInFlight = true;
  try {
    await context.globalState.update(LAST_CHECK_KEY, Date.now());
    await checkAndInstallExtensionUpdate(context, log);
  } finally {
    updateInFlight = false;
  }
}

/** Background scheduler — checks Open VSX and installs newer releases without UI noise. */
export function startExtensionAutoUpdate(
  context: vscode.ExtensionContext,
  log: (line: string) => void
): void {
  if (!shouldRunExtensionAutoUpdate(context)) {
    return;
  }

  const tick = () => {
    void runScheduledCheck(context, log);
  };

  const startupDelayMs = 45_000;
  const startupTimer = setTimeout(tick, startupDelayMs);
  updateTimer = setInterval(tick, extensionAutoUpdateIntervalMs());

  context.subscriptions.push({
    dispose: () => {
      clearTimeout(startupTimer);
      if (updateTimer) {
        clearInterval(updateTimer);
        updateTimer = undefined;
      }
    },
  });
}
