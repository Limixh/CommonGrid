// Fixture-only loopback endpoint INSIDE the isolated CLI namespace. No host
// port, personal credentials, Docker socket or network access is present.
import http from "node:http";
import { createInterface } from "node:readline";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";

const pending = new Map();
function rpc(kind, data) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("broker_timeout")); }, 30_000);
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    process.stdout.write(JSON.stringify({ id, kind, ...data }) + "\n");
  });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  try { const message = JSON.parse(line); const resolve = pending.get(message.id); pending.delete(message.id); resolve?.(message.result); } catch {}
});
function equalToken(value) {
  const actual = Buffer.from(value ?? ""), expected = Buffer.from(`Bearer ${process.env.CG_TOOL_TOKEN}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
mkdirSync("/home/node/.codex", { recursive: true });
mkdirSync("/home/node/claude", { recursive: true });
writeFileSync("/auth/canary.txt", process.env.CG_FAKE_IDENTITY);
writeFileSync("/home/node/mcp.json", JSON.stringify({ mcpServers: { commongrid: { command: "node", args: ["/fixtures/mcp.mjs"], env: { CG_TOOL_TOKEN: process.env.CG_TOOL_TOKEN } } } }));

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/ready") { res.end("ready"); return; }
    if (req.url === "/task" && !equalToken(req.headers.authorization)) { res.writeHead(401).end(); return; }
    if (!req.url?.startsWith("/v1/") && req.url !== "/task") { res.writeHead(404).end(); return; }
    let bytes = 0, text = "";
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 2_097_152) { res.writeHead(413).end(); return; } text += chunk; }
    const body = text ? JSON.parse(text) : {};
    if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ input_tokens: 32 })); return; }
    if (req.url === "/task") {
      const result = await rpc("task", { arguments: body });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result)); return;
    }
    if (req.method !== "POST" || ![/^\/v1\/responses(?:\?|$)/, /^\/v1\/messages(?:\?|$)/].some((pattern) => pattern.test(req.url))) { res.writeHead(404).end(); return; }
    const provider = req.url?.startsWith("/v1/responses") ? "codex" : "claude";
    const reply = await rpc("model", { provider, body });
    if (reply.error) { res.writeHead(500).end(JSON.stringify({ error: reply.error })); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of reply.events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch { res.writeHead(500).end(); }
});
server.listen(9876, "127.0.0.1", () => process.stdout.write(JSON.stringify({ kind: "ready" }) + "\n"));
