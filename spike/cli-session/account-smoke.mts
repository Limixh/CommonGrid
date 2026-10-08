// Explicit local developer check only. Fixed trusted prompt, no task text,
// repository inputs, credential copying or API-key fallback. Never run in CI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { codexFunctionalTestModel, claudeFunctionalTestModel } from "@commongrid/agent-adapters/testing/functional-test-models";

assert.equal(process.platform, "win32", "native subscription smoke is currently Windows-only");
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(root, ".local/account-smoke", randomUUID());
await mkdir(directory, { recursive: true });
const profile = process.env.USERPROFILE!;
const claude = path.join(profile, ".local/bin/claude.exe");
const codex = path.join(profile, "AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const env = { ...process.env };
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[key];
const report: Record<string, any> = { checked_at: new Date().toISOString(), platform: "win32", purpose: "native_subscription_fixed_text_only_connection_smoke", real_model_inference_attempted: true, task_execution_tested: false, os_identity_isolation_tested: false, credential_files_copied: false, paid_api_fallback: false, execution_enabled: false, isolation_gate: "not_evaluated", providers: {} };
const only = process.env.CG_SMOKE_PROVIDER;
function classify(message: unknown) {
  const text = String(message ?? "").toLowerCase();
  return [
    ["tls", /certificate|\btls\b|\bssl\b/], ["auth", /unauthorized|unauthenticated|expired|authentication/],
    ["quota", /rate.limit|quota|usage.limit/], ["model", /model.*not.*support|model.*not.*found|unsupported.*model/],
    ["network", /connect|network|socket|stream|http/], ["sandbox", /sandbox|permission|bubblewrap/],
    ["configuration", /config|provider|parameter/],
  ].find(([, pattern]) => (pattern as RegExp).test(text))?.[0] ?? "unclassified";
}
function capture(command: string, args: string[], timeout = 15_000, statusStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "", bytes = 0;
    const stop = () => { if (child.pid && child.exitCode === null) spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill()); };
    const timer = setTimeout(() => { stop(); reject(new Error("native_cli_timeout")); }, timeout);
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 1_048_576) { stop(); reject(new Error("native_output_limit")); } else text += chunk; });
    child.stderr.on("data", (chunk) => { if (statusStderr && text.length < 4096) text += chunk; }); // Status is matched in memory only; no raw diagnostics retained.
    child.on("error", () => { clearTimeout(timer); reject(new Error("native_cli_unavailable")); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(`native_cli_exit_${code}`)); });
  });
}
try {
  if (only === "codex") throw new Error("skip_provider");
  const status = JSON.parse(await capture(claude, ["auth", "status", "--json"]));
  assert.equal(status.loggedIn, true); assert.equal(status.authMethod, "claude.ai");
  report.providers.claude = { authenticated: true, method: "claude.ai", subscription: status.subscriptionType, status: "running" };
  const c = JSON.parse(await capture(claude, ["--print", "--output-format", "json", "--tools", "", "--restricted", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode", "dontAsk", "--model", claudeFunctionalTestModel, "--fallback-model", claudeFunctionalTestModel, "Reply with exactly CG_OK. Do not use any tools."], 90_000));
  assert.equal(c.is_error, false); assert.equal(c.subtype, "success"); assert.equal(c.result.trim(), "CG_OK");
  Object.assign(report.providers.claude, { status: "passed", fixed_reply_verified: true, model: claudeFunctionalTestModel });
  console.log("PASS Claude: native Claude.ai subscription connection, tools disabled");
} catch { if (only !== "codex") { report.providers.claude = { ...report.providers.claude, status: "failed" }; process.exitCode = 1; console.log("FAIL Claude native subscription smoke (private diagnostics not retained)"); } }

try {
  assert.match(await capture(codex, ["login", "status"], 15_000, true), /Logged in using ChatGPT/);
  report.providers.codex = { authenticated: true, method: "ChatGPT", status: "running" };
  const child = spawn(codex, ["app-server", "--listen", "stdio://", "-c", 'model_provider="openai"', "-c", `model="${codexFunctionalTestModel}"`, "-c", 'model_reasoning_effort="low"', "-c", "features.apps=false", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-c", "features.code_mode=false", "-c", "features.code_mode_only=false", "-c", 'web_search="disabled"', "-c", "tools.experimental_request_user_input.enabled=false"], { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0, answer = "", resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); done.catch(() => {});
  const stop = () => { child.stdin.end(); if (child.pid && child.exitCode === null) spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill()); };
  const timer = setTimeout(() => { stop(); reject(new Error("native_subscription_deadline")); for (const p of pending.values()) p.reject(new Error("native_subscription_deadline")); }, 90_000);
  let bytes = 0;
  child.stderr.on("data", () => {});
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    try {
      bytes += Buffer.byteLength(line); if (bytes > 2_097_152) throw new Error("native_output_limit");
      const event = JSON.parse(line);
      if (event.id !== undefined && !event.method) { const p = pending.get(event.id); pending.delete(event.id); if (event.error) report.providers.codex.rpc_error_code = event.error.code; event.error ? p?.reject(new Error("native_rpc_failed")) : p?.resolve(event.result); }
      else if (event.id !== undefined && event.method) { child.stdin.write(JSON.stringify({ id: event.id, error: { code: -32601, message: "Tools unavailable in connection smoke" } }) + "\n"); reject(new Error("unexpected_tool_or_approval_request")); }
      else if (event.method === "item/completed" && event.params?.item?.type === "agentMessage") answer += event.params.item.text;
      else if (event.method === "turn/completed") { report.providers.codex.turn_status = event.params.turn.status; report.providers.codex.turn_error_info = event.params.turn.error?.codexErrorInfo; if (event.params.turn.error) report.providers.codex.error_category = classify(event.params.turn.error.message); event.params.turn.status === "completed" ? resolve() : reject(new Error("native_turn_failed")); }
    } catch { reject(new Error("native_protocol_failed")); }
  });
  child.on("error", () => { reject(new Error("native_cli_unavailable")); for (const p of pending.values()) p.reject(new Error("native_cli_unavailable")); });
  child.on("exit", () => { reject(new Error("native_cli_ended")); for (const p of pending.values()) p.reject(new Error("native_cli_ended")); });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); child.stdin.write(JSON.stringify({ id: next, method, params }) + "\n"); });
  try {
    report.providers.codex.stage = "initialize";
    await request("initialize", { clientInfo: { name: "commongrid_connection_smoke", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const models = await request("model/list", {});
    const selected = models.data.find((item: any) => item.model === codexFunctionalTestModel && !item.hidden);
    assert.ok(selected?.model, "native_test_model_unavailable");
    report.providers.codex.model = selected.model;
    report.providers.codex.stage = "thread_start";
    const thread = await request("thread/start", { model: selected.model, cwd: directory, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, environments: [], dynamicTools: [], baseInstructions: "This is a connection smoke only. Do not use tools. Reply with exactly CG_OK." });
    assert.equal(thread.model, codexFunctionalTestModel, "native_test_model_mismatch");
    report.providers.codex.stage = "turn_start";
    await request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Reply with exactly CG_OK. Do not use any tools.", text_elements: [] }] });
    await done; assert.equal(answer.trim(), "CG_OK");
    Object.assign(report.providers.codex, { status: "passed", fixed_reply_verified: true, model: thread.model, environment_selection: "explicit_empty_array_experimental" });
    console.log("PASS Codex: native ChatGPT subscription connection, environment disabled");
  } finally { clearTimeout(timer); stop(); }
} catch (error: any) { report.providers.codex = { ...report.providers.codex, status: "failed", failure: /^(native_|unexpected_)/.test(error.message ?? "") ? error.message : "native_validation_failed" }; process.exitCode = 1; console.log("FAIL Codex native subscription smoke (private diagnostics not retained)"); }
report.success = ["codex", "claude"].every((provider) => report.providers[provider]?.status === "passed");
report.real_model_inference_verified = report.success;
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`Report: ${path.join(directory, "report.json")}`);
