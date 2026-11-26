import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export async function createBridge(port = 3014) {
  const token = randomBytes(24).toString("hex");
  let browser: WebSocket | undefined;
  let snapshot: unknown;
  let updated = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const rejectPending = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error("Browser disconnected; command outcome unknown. Read state before retrying."),
      );
    }
    pending.clear();
  };
  const http = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const supplied = Buffer.from(url.searchParams.get("token") ?? "");
    const origin = request.headers.origin;
    const allowed = ["http://127.0.0.1:3004", "http://localhost:3004"];
    if (
      url.pathname !== "/lab" ||
      !origin ||
      !allowed.includes(origin) ||
      supplied.length !== token.length ||
      !timingSafeEqual(supplied, Buffer.from(token)) ||
      browser
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (ws: WebSocket) => {
    browser = ws;
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(
          (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString(),
        ) as {
          type?: string;
          snapshot?: unknown;
          id?: string;
          error?: string;
        };
        if (message.type === "snapshot") {
          snapshot = message.snapshot;
          updated = Date.now();
        }
        if (message.type === "reply" && message.id) {
          const request = pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error));
          else {
            snapshot = message.snapshot;
            updated = Date.now();
            request.resolve(snapshot);
          }
        }
      } catch {
        ws.close(1008, "Invalid message");
      }
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      browser = undefined;
      snapshot = undefined;
      updated = 0;
      rejectPending();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });
  const address = http.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `ws://127.0.0.1:${actualPort}/lab?token=${token}`,
    read() {
      if (!browser || !updated || Date.now() - updated > 3000)
        throw new Error("No fresh browser state. Open the lab and connect its Agent panel.");
      return snapshot;
    },
    command(command: unknown): Promise<unknown> {
      if (!browser || browser.readyState !== WebSocket.OPEN || Date.now() - updated > 3000)
        return Promise.reject(new Error("No fresh browser connection"));
      if (pending.size >= 8) return Promise.reject(new Error("Too many pending commands"));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Command timed out; outcome unknown. Read state before retrying."));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        browser!.send(JSON.stringify({ type: "command", id, command }));
      });
    },
    async close() {
      rejectPending();
      browser?.terminate();
      sockets.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
