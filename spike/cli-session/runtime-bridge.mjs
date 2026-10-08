// Inside the CLI network-none namespace. HTTPS CONNECT is TLS passthrough:
// no credential/header/body inspection and no external socket in this process.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Frames, sendFrame, sendData, decodeData } from "./tunnel-wire.mjs";
import { createTaskBroker } from "./task-broker.mjs";
const sockets = new Map(), tasks = new Map();
const send = value => sendFrame(process.stdout, value);
const frames = process.stdin.pipe(new Frames());
const stop = () => { for (const socket of sockets.values()) socket.destroy(); process.exit(1); };
frames.on("error", stop); process.stdin.on("end", stop); process.stdout.on("error", stop);
frames.on("data", message => {
  try {
    const socket = sockets.get(message.id);
    if (message.kind === "connected" && socket) { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); socket.emit("tunnel-ready"); }
    else if (message.kind === "data" && socket) {
      if (!socket.write(decodeData(message.data))) { frames.pause(); socket.once("drain", () => frames.resume()); }
    } else if (message.kind === "close" && socket) socket.destroy();
    else if (message.kind === "task-result") { const task = tasks.get(message.id); tasks.delete(message.id); task?.(message.result); }
  } catch { stop(); }
});
mkdirSync("/home/node/.codex", { recursive: true, mode: 0o700 });
mkdirSync("/home/node/claude", { recursive: true, mode: 0o700 });
writeFileSync("/home/node/mcp.json", JSON.stringify({ mcpServers: { commongrid: { command: "node", args: ["/opt/cg/mcp.mjs"], env: { CG_TOOL_TOKEN: process.env.CG_TOOL_TOKEN } } } }), { mode: 0o600 });
const proxy = http.createServer({ maxHeaderSize: 8192 }, (req, res) => res.writeHead(405).end());
proxy.on("connect", (req, socket, head) => {
  if (sockets.size >= 16 || head.length > 24_576) { socket.destroy(); return; }
  const id = randomUUID(); sockets.set(id, socket); socket.setTimeout(120_000, () => socket.destroy());
  socket.pause();
  socket.once("tunnel-ready", () => { if (head.length) sendData(process.stdout, id, head); socket.resume(); });
  socket.on("data", bytes => { if (!sendData(process.stdout, id, bytes)) { socket.pause(); process.stdout.once("drain", () => socket.resume()); } });
  socket.on("error", () => {});
  socket.on("close", () => { sockets.delete(id); send({ kind: "close", id }); });
  send({ kind: "connect", id, authority: req.url });
});
const broker = createTaskBroker({ token: process.env.CG_TOOL_TOKEN, execute: async args => {
    const id = randomUUID();
    return await new Promise(resolve => {
      const timer = setTimeout(() => { tasks.delete(id); resolve({ error: "task_deadline" }); }, 35_000);
      tasks.set(id, value => { clearTimeout(timer); resolve(value); }); send({ kind: "task", id, arguments: args });
    });
} });
proxy.headersTimeout = 5000;
proxy.listen(9877, "127.0.0.1", () => broker.listen(9876, "127.0.0.1", () => send({ kind: "ready" })));
