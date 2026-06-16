import * as http from "node:http";
import { handleHookRequest } from "./hookHandlers";

export const DEFAULT_HOOK_PORT = 4895;

let _server: http.Server | undefined;
let _port: number = DEFAULT_HOOK_PORT;

export function getHookServerPort(): number {
  return _port;
}

export function hookBaseUrl(): string {
  return `http://127.0.0.1:${_port}`;
}

function requestHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    void (async () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = new URL(req.url ?? "/", "http://localhost");
        const segments = parsed.pathname.replace(/^\/+/, "").split("/");
        const hookName = segments[0] === "hook" ? (segments[1] ?? "") : segments[0];
        const agent = parsed.searchParams.get("agent") ?? "claude";
        const cwdParam = parsed.searchParams.get("cwd");
        const cwd = cwdParam ? decodeURIComponent(cwdParam) : process.cwd();

        let bodyJson: unknown = {};
        if (body) {
          try { bodyJson = JSON.parse(body); } catch { /* use empty object */ }
        }

        const result = await handleHookRequest({ hookName, agent, cwd, body: bodyJson });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result ?? {}));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    })();
  });
}

function tryBind(srv: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("listening", () => {
      const addr = srv.address();
      resolve(addr && typeof addr !== "string" ? addr.port : port);
    });
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1");
  });
}

export async function startHookServer(preferredPort = DEFAULT_HOOK_PORT): Promise<void> {
  if (_server) return;

  const srv = http.createServer(requestHandler);

  try {
    _port = await tryBind(srv, preferredPort);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      srv.removeAllListeners("error");
      srv.removeAllListeners("listening");
      _port = await tryBind(srv, 0);
    } else {
      throw err;
    }
  }

  _server = srv;
}

export function stopHookServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (_server) {
      _server.close(() => {
        _server = undefined;
        _port = DEFAULT_HOOK_PORT;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
