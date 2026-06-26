import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// MIME types served by the built-in dashboard server
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// ---------------------------------------------------------------------------
// Module-level state (single server + panel per extension lifetime)
// ---------------------------------------------------------------------------
let server: http.Server | undefined;
let serverPort = 0;
let statusBarItem: vscode.StatusBarItem | undefined;
let dashboardPanel: vscode.WebviewPanel | undefined;
/** Absolute path of the index.html we copied into the workspace — so we only
 *  delete what we placed there, never a file the user owned beforehand. */
let deployedIndexPath: string | undefined;

// ---------------------------------------------------------------------------
// Port helper — finds next free port starting from `start`
// ---------------------------------------------------------------------------
function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(start, "127.0.0.1", () => {
      const addr = probe.address() as net.AddressInfo;
      probe.close(() => resolve(addr.port));
    });
    probe.on("error", () => findFreePort(start + 1).then(resolve, reject));
  });
}

// ---------------------------------------------------------------------------
// HTTP server — serves workspace root so index.html + .claude/learning/* work
// ---------------------------------------------------------------------------
function buildServer(workspaceRoot: string): http.Server {
  const root = path.resolve(workspaceRoot);

  return http.createServer((req, res) => {
    let urlPath = (req.url ?? "/").split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";

    const abs = path.resolve(root, "." + urlPath);

    // Security: never escape the workspace root
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    fs.readFile(abs, (err, data) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
        res.writeHead(code, { "Content-Type": "text/plain" });
        res.end(code === 404 ? "Not found" : "Server error");
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(data);
    });
  });
}

// ---------------------------------------------------------------------------
// index.html lifecycle — copy from extension resources / delete on stop
// ---------------------------------------------------------------------------
function deployDashboardHtml(extensionPath: string, workspaceRoot: string, log: (msg: string) => void): void {
  const src  = path.join(extensionPath, "resources", "learning-dashboard.html");
  const dest = path.join(workspaceRoot, "index.html");
  try {
    fs.copyFileSync(src, dest);
    deployedIndexPath = dest;
    log(`[LearningDashboard] Deployed index.html → ${dest}`);
  } catch (err) {
    log(`[LearningDashboard] Warning: could not copy dashboard HTML: ${(err as Error).message}`);
  }
}

function removeDashboardHtml(log: (msg: string) => void): void {
  if (!deployedIndexPath) return;
  try {
    if (fs.existsSync(deployedIndexPath)) {
      fs.unlinkSync(deployedIndexPath);
      log(`[LearningDashboard] Removed index.html from ${deployedIndexPath}`);
    }
  } catch (err) {
    log(`[LearningDashboard] Warning: could not remove dashboard HTML: ${(err as Error).message}`);
  } finally {
    deployedIndexPath = undefined;
  }
}

// ---------------------------------------------------------------------------
// Start / stop helpers
// ---------------------------------------------------------------------------
async function startDashboardServer(
  workspaceRoot: string,
  log: (msg: string) => void
): Promise<void> {
  const port = await findFreePort(3099);
  server = buildServer(workspaceRoot);
  await new Promise<void>((resolve, reject) => {
    server!.listen(port, "127.0.0.1", resolve);
    server!.on("error", reject);
  });
  serverPort = port;
  log(`[LearningDashboard] Server started → http://localhost:${port}`);
}

function stopDashboardServer(log: (msg: string) => void): void {
  server?.close(() => log("[LearningDashboard] Server stopped"));
  server = undefined;
  serverPort = 0;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function refreshStatusBar(): void {
  if (!statusBarItem) return;
  if (server) {
    statusBarItem.text = `$(broadcast) Dashboard ON :${serverPort}`;
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**Learning Dashboard** running at \`http://localhost:${serverPort}\`\n\nClick to **stop** the server`
    );
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBarItem.text = `$(graph-line) Dashboard`;
    statusBarItem.tooltip = "Click to start the Learning Dashboard server";
    statusBarItem.backgroundColor = undefined;
  }
}

// ---------------------------------------------------------------------------
// WebviewPanel HTML — thin iframe wrapper with toolbar
// ---------------------------------------------------------------------------
function buildPanelHtml(port: number): string {
  const url = `http://localhost:${port}`;
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           frame-src http://localhost:${port} http://127.0.0.1:${port};
           style-src 'unsafe-inline';
           script-src 'unsafe-inline';">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;display:flex;flex-direction:column;height:100vh;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.bar{display:flex;align-items:center;justify-content:space-between;padding:5px 12px;background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;gap:8px}
.bar-l{display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:#3fb950;flex-shrink:0;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.title{font-size:12px;font-weight:600;color:#e6edf3}
.url{font-size:10px;color:#6e7681;font-family:'SF Mono',monospace}
.bar-r{display:flex;gap:6px}
button{padding:3px 10px;border-radius:5px;border:1px solid #30363d;background:#21262d;color:#e6edf3;font-size:11px;cursor:pointer;font-family:inherit}
button:hover{background:#2d333b;border-color:#444c56}
.btn-stop{border-color:rgba(248,81,73,.35);color:#f85149}
.btn-stop:hover{background:rgba(248,81,73,.1)}
iframe{flex:1;border:none;width:100%;height:100%}
</style>
</head>
<body>
<div class="bar">
  <div class="bar-l">
    <div class="dot"></div>
    <span class="title">Learning Dashboard</span>
    <span class="url">${url}</span>
  </div>
  <div class="bar-r">
    <button onclick="reload()">↻ Refresh</button>
    <button onclick="openBrowser()">Open in Browser ↗</button>
    <button class="btn-stop" onclick="stopServer()">■ Stop Server</button>
  </div>
</div>
<iframe id="frame" src="${url}" title="Learning Dashboard"></iframe>
<script>
const vscodeApi = acquireVsCodeApi();
function reload(){const f=document.getElementById('frame');f.src=f.src}
function openBrowser(){vscodeApi.postMessage({command:'openBrowser'})}
function stopServer(){vscodeApi.postMessage({command:'stopServer'})}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public: register commands
// ---------------------------------------------------------------------------
export interface LearningDashboardOpts {
  context: vscode.ExtensionContext;
  getTarget: () => string | undefined;
  log: (msg: string) => void;
  extensionPath?: string; // falls back to context.extensionPath
}

export function registerLearningDashboardCommands(
  opts: LearningDashboardOpts
): vscode.Disposable[] {
  const { context, getTarget, log } = opts;
  const extPath = opts.extensionPath ?? context.extensionPath;

  // Status bar — right-aligned, just before existing status bar items
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
  statusBarItem.command = "claudeSkills.toggleLearningDashboard";
  statusBarItem.show();
  refreshStatusBar();
  context.subscriptions.push(statusBarItem);

  // ── Toggle command ────────────────────────────────────────────────────────
  const toggle = vscode.commands.registerCommand(
    "claudeSkills.toggleLearningDashboard",
    async () => {
      if (server) {
        // ── TURN OFF ──────────────────────────────────────────────────────
        dashboardPanel?.dispose();   // fires onDidDispose which nulls the ref
        stopDashboardServer(log);
        removeDashboardHtml(log);
        refreshStatusBar();
        void vscode.window.showInformationMessage("Learning Dashboard stopped.");
      } else {
        // ── TURN ON ───────────────────────────────────────────────────────
        const workspaceRoot = getTarget();
        if (!workspaceRoot) {
          void vscode.window.showErrorMessage(
            "No workspace folder open — cannot start Learning Dashboard."
          );
          return;
        }

        deployDashboardHtml(extPath, workspaceRoot, log);

        try {
          await startDashboardServer(workspaceRoot, log);
        } catch (err) {
          removeDashboardHtml(log); // clean up if server fails to start
          void vscode.window.showErrorMessage(
            `Failed to start dashboard server: ${(err as Error).message}`
          );
          return;
        }

        refreshStatusBar();
        openOrRevealPanel(serverPort, log);

        const url = `http://localhost:${serverPort}`;
        const pick = await vscode.window.showInformationMessage(
          `Learning Dashboard running at ${url}`,
          "Open in Browser",
          "Copy URL"
        );
        if (pick === "Open in Browser") {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (pick === "Copy URL") {
          void vscode.env.clipboard.writeText(url);
        }
      }
    }
  );

  return [toggle];
}

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------
function openOrRevealPanel(port: number, log: (msg: string) => void): void {
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.Beside);
    dashboardPanel.webview.html = buildPanelHtml(port); // update port if changed
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    "claudeSkillsLearningDashboard",
    "Learning Dashboard",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  dashboardPanel.webview.html = buildPanelHtml(port);

  // Handle messages from the webview toolbar buttons
  dashboardPanel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
    if (msg.command === "openBrowser") {
      void vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${serverPort}`));
    }
    if (msg.command === "stopServer") {
      dashboardPanel?.dispose();
      stopDashboardServer(log);
      removeDashboardHtml(log);
      refreshStatusBar();
      void vscode.window.showInformationMessage("Learning Dashboard stopped.");
    }
  });

  dashboardPanel.onDidDispose(() => {
    dashboardPanel = undefined;
  });
}
