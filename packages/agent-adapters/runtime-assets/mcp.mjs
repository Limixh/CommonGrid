// Minimal fixture MCP stdio bridge. The only tool executes in a task container.
import { createInterface } from "node:readline";
const schema = { type: "object", properties: { argv: { type: "array", minItems: 1, maxItems: 128, items: { type: "string", maxLength: 65536 } }, timeout_ms: { type: "integer", minimum: 1, maximum: 30000 } }, required: ["argv"], additionalProperties: false };
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", async (line) => {
  if (Buffer.byteLength(line) > 1_048_576) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") { send(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "commongrid-fixture", version: "0.1.0" } }); return; }
  if (message.method === "ping") { send(message.id, {}); return; }
  if (message.method === "tools/list") { send(message.id, { tools: [{ name: "task_exec", description: "Execute argv inside this attempt's isolated network-off task workspace. Cannot select a host path or another attempt.", inputSchema: schema }] }); return; }
  if (message.method === "tools/call" && message.params?.name === "task_exec") {
    try {
      const response = await fetch("http://127.0.0.1:9876/task", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CG_TOOL_TOKEN}` }, body: JSON.stringify(message.params.arguments), signal: AbortSignal.timeout(35_000) });
      if (!response.ok) throw new Error("broker_denied");
      const result = await response.json();
      send(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: !!result.error });
    } catch { send(message.id, { content: [{ type: "text", text: "broker_unavailable" }], isError: true }); }
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method_not_found" } }) + "\n");
});
