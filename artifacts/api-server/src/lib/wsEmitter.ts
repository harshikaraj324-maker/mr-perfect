import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

let wss: WebSocketServer | null = null;

export function initWss(server: Server): void {
  wss = new WebSocketServer({ server, path: "/api/events" });
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    ws.send(JSON.stringify({ event: "connected", data: { ok: true } }));
  });
}

export function broadcast(event: string, data: unknown): void {
  if (!wss) return;
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}
