import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { TaskToolsRuntime, dockerCommand } from "../../packages/agent-adapters/src/task-runtime.ts";
import { executeTaskTool, validateTaskTool } from "../../packages/agent-adapters/src/task-tool.ts";
import { parseClaudeLine, parseCodexAppServerLine } from "../../packages/agent-adapters/src/provider-events.ts";
import { claudeEvents, codexEvents, advertisedToolNames } from "./model-fixture.mjs";
import { ManagedCliRuntime } from "./managed-runtime.mts";
import { codingCatalog, profileFile, profileProof, codexCodingModel } from "./codex-profile.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("binaries.lock.json", import.meta.url), "utf8"));
const base = JSON.parse(await readFile(new URL("../sandbox/image.lock.json", import.meta.url), "utf8"));
const schema = JSON.parse(await readFile(new URL("tool-schema.json", import.meta.url), "utf8"));
const codexModel=process.env.CG_FIXTURE_CODEX_MODEL??"gpt-5.1-codex";
const directProfile=process.env.CG_FIXTURE_CODEX_DIRECT_PROFILE==="1";
assert.ok(!directProfile||codexModel===codexCodingModel);
assert.ok(["gpt-5.1-codex","gpt-5.6-sol","gpt-6-astra","gpt-6-luna"].includes(codexModel),"unreviewed fixture model selection");
const runId = randomUUID(), image = base.image;
const directory = path.join(root, ".local/cli-session", runId);
await mkdir(directory, { recursive: true });
const label = `io.commongrid.spike.owner=${runId}`;
const containers: string[] = [], runtimes: TaskToolsRuntime[] = [], children: ChildProcessWithoutNullStreams[] = [];
const managedCaches: {runtime:ManagedCliRuntime;container:string}[]=[];
const report: Record<string, any> = {
  schema_version: "1.0", checked_at: new Date().toISOString(), platform: process.platform,
  purpose: "official_cli_binaries_local_wire_fixture_and_task_tool_routing",
  real_account_tested: false, real_model_inference: false, execution_enabled: false, isolation_gate: "not_evaluated",
  base_image: base.image, providers: {}, cleanup_confirmed: false,
};
async function checked(args: string[], timeoutMs = 10_000) {
  const r = await dockerCommand(args, { timeoutMs });
  if (r.code !== 0) { await writeFile(path.join(directory, "last-docker-error.txt"), r.stderr); report.failed_operation = { operation: args[0], exit_code: r.code, stage: report.setup_stage }; throw new Error("fixture_docker_failed"); }
  return r.stdout.trim();
}
async function deliver(container: string, source: string, target: string) {
  const r = await dockerCommand(["exec", "-i", "--user", "0:0", container, "node", "-e",
    "const fs=require('node:fs');const out=fs.createWriteStream(process.argv[1],{flags:'wx',mode:0o555});out.on('error',()=>process.exit(1));process.stdin.pipe(out);", target],
    { timeoutMs: 120_000, stdin: createReadStream(source) });
  if (r.code !== 0) throw new Error("fixture_delivery_failed");
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function deadline<T>(promise: Promise<T>, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture_deadline")), ms); })]); }
  finally { clearTimeout(timer!); }
}
function pipe(args: string[], line: (value: any) => void, exit: (code: number | null) => void) {
  const child = spawn("docker", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (data) => { if (stderr.length < 16_384) stderr += data; });
  let bytes = 0;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (text) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 8_388_608 || Buffer.byteLength(text) > 2_097_152) { child.kill(); exit(1); return; }
    try { line(JSON.parse(text)); } catch { exit(1); }
  });
  child.on("error", () => exit(1));
  child.on("exit", (code) => {
    void writeFile(path.join(directory, `process-${children.indexOf(child)}.stderr.txt`), stderr);
    exit(code);
  });
  return child;
}
const fixtureSource = `const fs=require('node:fs');const net=require('node:net');fs.writeFileSync('/task/result.txt','created by the official CLI through the task broker');let denied=false;try{fs.readFileSync('/auth/canary.txt')}catch{denied=true}const env=JSON.stringify(process.env)+fs.readFileSync('/proc/1/environ','utf8');const socket=net.connect({host:'127.0.0.1',port:9876});let finished=false;function done(connected){if(finished)return;finished=true;socket.destroy();console.log(JSON.stringify({auth_denied:denied,identity_env_absent:!env.includes('CG_FAKE_IDENTITY')&&!env.includes('CG_TOOL_TOKEN'),control_unreachable:!connected}));}socket.on('connect',()=>done(true));socket.on('error',()=>done(false));socket.setTimeout(300,()=>done(false));`;
const args = { argv: ["node", "-e", fixtureSource], timeout_ms: 3000 };

async function providerTest(provider: "codex" | "claude") {
  const start = performance.now();
  const runtime = await TaskToolsRuntime.create({ image: base.image, cpu: 1, memoryMb: 256 }, 300_000);
  runtimes.push(runtime);
  const taskStartup = performance.now() - start;
  const container = `cg-cli-${provider}-${runId}`;
  const token = randomBytes(32).toString("hex"), canary = `CG_FAKE_${randomUUID()}`;
  const cache=provider === "codex"&&process.env.CG_FIXTURE_CODEX_TOOLS_OWNER?ManagedCliRuntime.restore({owner:process.env.CG_FIXTURE_CODEX_TOOLS_OWNER,provider:"codex"}):undefined;
  if(cache){managedCaches.push({runtime:cache,container});await cache.beginOperation();await cache.verify("volume",cache.toolsVolume);}
  const setupStart = performance.now();
  report.setup_stage = `${provider}:create`;
  containers.push(container);
  await checked(["create", "--name", container, "--label", label, "--network", "none", "--read-only", "--user", "1000:1000", "--workdir", "/home/node",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--cpus", "1", "--memory", "1024m", "--memory-swap", "1024m", "--init",
    "--tmpfs", "/home/node:rw,nosuid,size=128m,uid=1000,gid=1000,mode=0700",
    "--tmpfs", "/auth:rw,noexec,nosuid,size=1m,uid=1000,gid=1000,mode=0700",
    ...(cache?["--mount",`type=volume,src=${cache.toolsVolume},dst=/opt/cg-cli,readonly,volume-nocopy`]:["--tmpfs", "/opt/cg-cli:rw,exec,nosuid,size=384m,mode=0755"]),
    "--tmpfs", "/fixtures:rw,noexec,nosuid,size=4m,mode=0755",
    "--tmpfs", "/tmp:rw,nosuid,size=128m", "--env", `CG_TOOL_TOKEN=${token}`, "--env", `CG_FAKE_IDENTITY=${canary}`,
    "--env", "ANTHROPIC_API_KEY=cg-fixture-not-a-real-key", "--env", "ANTHROPIC_BASE_URL=http://127.0.0.1:9876",
    "--env", "CLAUDE_CONFIG_DIR=/home/node/claude", "--env", "DISABLE_AUTOUPDATER=1", "--env", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "--env", "ENABLE_CLAUDEAI_MCP_SERVERS=false", "--env", "ENABLE_TOOL_SEARCH=false", image, "node", "-e", "setTimeout(()=>process.exit(0),600000)"]);
  await checked(["start", container]);
  report.setup_stage = `${provider}:binary_delivery`;
  // Trusted initialization streams only verified public binaries/source into
  // tmpfs. Docker cp rejects read-only roots even when the target is tmpfs.
  // There are no host bind mounts or account files; no Buildx is needed.
  if(!cache)await deliver(container, path.join(root, ".tools/cli-fixtures", provider), `/opt/cg-cli/${provider}`);
  else assert.equal(await checked(["exec",container,"node","-e","const fs=require('node:fs'),c=require('node:crypto'),h=c.createHash('sha256'),s=fs.createReadStream('/opt/cg-cli/codex');s.on('data',x=>h.update(x));s.on('end',()=>console.log(h.digest('hex')));"]),lock.codex.binary_sha256);
  await deliver(container, fileURLToPath(new URL("control.mjs", import.meta.url)), "/fixtures/control.mjs");
  await deliver(container, fileURLToPath(new URL("../../packages/agent-adapters/runtime-assets/mcp.mjs", import.meta.url)), "/fixtures/mcp.mjs");
  const catalog=provider === "codex"&&directProfile?await codingCatalog():undefined;
  if(catalog)await deliver(container,profileFile,"/fixtures/catalog.json");
  await checked(["exec", "--user", "0:0", container, "/bin/chmod", "0555", ...(cache?[]:[`/opt/cg-cli/${provider}`, "/opt/cg-cli"]), "/fixtures"]);
  report.setup_stage = `${provider}:version`;
  const versionStart = performance.now();
  const version = await checked(["exec", container, `/opt/cg-cli/${provider}`, "--version"]);
  const versionMs = performance.now() - versionStart;
  assert.equal(version, provider === "codex" ? `codex-cli ${lock.codex.version}` : `${lock.claude.version} (Claude Code)`);
  const result: Record<string, any> = { version, fixture_model: provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.1-codex", task_startup_ms: Math.round(taskStartup), cli_setup_ms: Math.round(performance.now()-setupStart), cli_binary_size_bytes: (await stat(path.join(root,".tools/cli-fixtures",provider))).size, version_probe_ms: Math.round(versionMs), model_requests: 0, task_tool_calls: 0, advertised_tools: [], checks: [], status: "running" };
  report.providers[provider] = result;
  if(provider === "codex")result.fixture_model=codexModel;
  result.public_binary_delivery=cache?"owned_readonly_verified_public_tools_cache":"verified_public_binary_tmpfs";
  if(catalog)result.catalog_sha256=catalog.sha256;
  const ready = deferred<void>();
  const finished = deferred<void>();
  let control!: ChildProcessWithoutNullStreams;
  control = pipe(["exec", "-i", container, "node", "/fixtures/control.mjs"], (message) => {
    if (message.kind === "ready") { ready.resolve(); return; }
    void (async () => {
      let reply: unknown;
      if (message.kind === "task") {
        result.broker_requests = (result.broker_requests ?? 0) + 1;
        try { validateTaskTool(message.arguments); result.task_tool_calls++; }
        catch { result.rejected_broker_requests = (result.rejected_broker_requests ?? 0) + 1; }
        reply = await executeTaskTool(runtime, message.arguments);
        result.last_task_result = reply;
      } else if (message.kind === "model") {
        result.model_requests++;
        assert.equal(message.provider, provider);
        assert.ok(!JSON.stringify(message.body).includes(canary));
        assert.ok(!JSON.stringify(message.body).includes(token));
        if (result.model_requests <= 2) await writeFile(path.join(directory, `${provider}-request-${result.model_requests}.json`), JSON.stringify(message.body, null, 2));
        const names = advertisedToolNames(message.body);
        result.advertised_tools = [...new Set([...result.advertised_tools, ...names])];
        const taskName = provider === "claude" ? "mcp__commongrid__task_exec" : catalog ? "functions.task_exec" : "task_exec";
        const tool = names.find((name: string) => name === taskName);
        const allowed = provider === "claude" ? [taskName] : catalog ? [taskName] : [taskName, "update_plan"];
        const forbidden = names.filter((name: string) => !allowed.includes(name));
        assert.deepEqual(forbidden, [], "unreviewed tool in the actual CLI request");
        assert.ok(tool, "task tool must be advertised to the real CLI request");
        const done = result.model_requests > 1;
        reply = { events: provider === "claude" ? claudeEvents(tool, args, message.body.model, done) : codexEvents(tool, args, message.body.model, done) };
      } else reply = { error: "unsupported_fixture_request" };
      control.stdin.write(JSON.stringify({ id: message.id, result: reply }) + "\n");
    })().catch((error) => { result.fixture_error = error instanceof Error ? error.message : "fixture_error"; finished.reject(error); control.stdin.write(JSON.stringify({ id: message.id, result: { error: "fixture_rejected" } }) + "\n"); });
  }, (code) => { if (code !== 0) ready.reject(new Error("fixture_control_failed")); });
  await deadline(ready.promise, 15_000);
  const cliStart = performance.now();
  if (provider === "claude") {
    const child = pipe(["exec", "-i", container, "/opt/cg-cli/claude", "--print", "--verbose", "--output-format", "stream-json", "--tools", "", "--restricted", "--strict-mcp-config", "--mcp-config", "/home/node/mcp.json", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode", "dontAsk", "--allowedTools", "mcp__commongrid__task_exec", "--model", "claude-sonnet-4-6", "Use task_exec for this fixture and report its result."], (event) => {
      if (event.type === "result") {
        assert.equal(parseClaudeLine(JSON.stringify(event)).type, "completed");
        result.cli_result = { subtype: event.subtype, is_error: event.is_error };
        if (event.is_error || event.subtype !== "success") finished.reject(new Error("claude_turn_failed"));
        else finished.resolve();
      }
    }, (code) => { if (code !== 0) finished.reject(new Error("claude_process_failed")); });
    child.stdin.end();
  } else {
    const waiting = new Map<number, ReturnType<typeof deferred<any>>>();
    let sequence = 0, threadId: string | undefined;
    const child = pipe(["exec", "-i", container, "/opt/cg-cli/codex", "app-server", "--listen", "stdio://",
      "-c", `model="${codexModel}"`,
      ...(catalog?["-c",'model_catalog_json="/fixtures/catalog.json"',"-c","agents.enabled=false","-c",'model_reasoning_effort="low"']:[]),
      "-c", 'model_provider="cg_fixture"', "-c", 'model_providers.cg_fixture.name="CommonGrid local wire fixture"',
      "-c", 'model_providers.cg_fixture.base_url="http://127.0.0.1:9876/v1"', "-c", 'model_providers.cg_fixture.wire_api="responses"',
      "-c", "model_providers.cg_fixture.requires_openai_auth=false", "-c", "model_providers.cg_fixture.supports_websockets=false",
      "-c", 'web_search="disabled"', "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-c", "features.apps=false",
      "-c", "features.code_mode_only=false", "-c", "features.code_mode=false", "-c", "features.goals=false",
      "-c", "features.current_time_reminder=false", "-c", "features.sleep_tool=false", "-c", "features.tool_search=false",
      "-c", "features.token_budget=false", "-c", "tools.experimental_request_user_input.enabled=false"], (message) => {
      if (message.id !== undefined && !message.method) {
        const promise = waiting.get(message.id); waiting.delete(message.id);
        if (message.error) promise?.reject(new Error(`codex_rpc_${message.error.code}`)); else promise?.resolve(message.result);
      } else if (message.method === "item/tool/call") {
        void (async () => {
          assert.equal(message.params.threadId, threadId);
          assert.equal(message.params.tool, "task_exec");
          // The default wire namespace is removed by the CLI for this bare dynamic tool.
          assert.equal(message.params.namespace ?? null, null);
          result.task_tool_calls++;
          const reply = await executeTaskTool(runtime, message.params.arguments);
          result.last_task_result = reply;
          child.stdin.write(JSON.stringify({ id: message.id, result: { success: !("error" in reply) && reply.exit_code === 0, contentItems: [{ type: "inputText", text: JSON.stringify(reply) }] } }) + "\n");
        })().catch((error) => finished.reject(error));
      } else if (message.method === "turn/completed") {
        assert.equal(parseCodexAppServerLine(JSON.stringify(message)).type, "completed");
        result.cli_result = { status: message.params.turn.status };
        if (message.params.turn.status === "completed") finished.resolve(); else finished.reject(new Error("codex_turn_failed"));
      } else if (message.id !== undefined && message.method) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported_fixture_request" } }) + "\n");
      }
    }, (code) => { if (code !== 0) finished.reject(new Error("codex_process_failed")); });
    const request = async (method: string, params: unknown) => {
      const id = ++sequence, promise = deferred<any>(); waiting.set(id, promise);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      return deadline(promise.promise, 20_000);
    };
    await request("initialize", { clientInfo: { name: "commongrid_fixture", title: "CommonGrid fixture", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const thread = await request("thread/start", { model: codexModel, modelProvider: "cg_fixture", cwd: "/home/node", approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      environments: [], baseInstructions: "Use only the supplied task_exec tool for the fixture. Return a brief completion.",
      dynamicTools: [{ type: "function", name: "task_exec", description: "Execute argv in the isolated task workspace through the CommonGrid broker.", inputSchema: schema }] });
    threadId = thread.thread.id;
    result.environment_selection = "explicit_empty_array_experimental";
    await request("turn/start", { threadId, input: [{ type: "text", text: "Use task_exec for this fixture and report its result.", text_elements: [] }] });
  }
  await deadline(finished.promise, 90_000);
  result.cli_turn_ms = Math.round(performance.now() - cliStart);
  assert.equal(result.fixture_error, undefined);
  assert.equal(result.task_tool_calls, 1);
  assert.ok(result.model_requests >= 2);
  assert.equal(result.last_task_result.exit_code, 0);
  assert.deepEqual(JSON.parse(result.last_task_result.stdout), { auth_denied: true, identity_env_absent: true, control_unreachable: true });
  const file = await runtime.exec(["node", "-e", "console.log(require('node:fs').readFileSync('/task/result.txt','utf8'))"]);
  assert.equal(file.stdout.trim(), "created by the official CLI through the task broker");
  const auth = await checked(["exec", container, "node", "-e", "console.log(require('node:fs').readFileSync('/auth/canary.txt','utf8')===process.env.CG_FAKE_IDENTITY)"]);
  assert.equal(auth, "true");
  const status = JSON.parse(await checked(["exec", container, "node", "-e", "const fs=require('node:fs');console.log(JSON.stringify({memory_current:fs.readFileSync('/sys/fs/cgroup/memory.current','utf8').trim(),memory_peak:fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8').trim()}))"]));
  result.cli_memory_current_bytes = Number(status.memory_current);
  result.cli_memory_peak_bytes = Number(status.memory_peak);
  const taskMemory = await runtime.exec(["node", "-e", "const fs=require('node:fs');console.log(JSON.stringify({current:Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8')),peak:Number(fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8'))}))"]);
  result.task_memory_bytes = JSON.parse(taskMemory.stdout);
  const invalid = await checked(["exec", container, "node", "-e", "(async()=>{const url='http://127.0.0.1:9876/task';const denied=await fetch(url,{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'});const wrongScope=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+process.env.CG_TOOL_TOKEN,'content-type':'application/json'},body:JSON.stringify({argv:['/bin/true'],container:'another-attempt'})});console.log(JSON.stringify({unauthorized:denied.status,scope:(await wrongScope.json()).error}));})();"]);
  assert.deepEqual(JSON.parse(invalid), { unauthorized: 401, scope: "task_tool_failed" });
  delete result.last_task_result;
  result.checks = ["official_binary_version", "real_cli_wire_request", "native_file_command_tools_absent", "task_tool_roundtrip", "task_workspace_written", "fake_auth_inaccessible_to_task", "control_unreachable_to_task", "canary_unchanged", "wrong_control_token_denied", "attempt_selection_denied"];
  result.status = "passed";
  if(catalog)await writeFile(profileProof,JSON.stringify({success:true,model:codexModel,catalog_sha256:catalog.sha256,advertised_tools:result.advertised_tools,source_run_id:runId,official_cli_version:lock.codex.version},null,2)+"\n");
  console.log(`PASS ${provider}: ${result.checks.length} checks, ${result.cli_turn_ms} ms local fixture turn`);
  await runtime.close();
  runtimes.splice(runtimes.indexOf(runtime), 1);
}

async function closeCli(container: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const listed = await checked(["container", "ls", "--all", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"], 30_000);
      if (!listed.split(/\r?\n/).includes(container)) return;
      assert.equal(await checked(["inspect", "--format", '{{index .Config.Labels "io.commongrid.spike.owner"}}', container], 30_000), runId);
      await checked(["rm", "--force", container], 30_000);
      // Absence is checked again; a timed-out remove can have succeeded.
    } catch (error) {
      (report.cleanup_attempt_errors ??= []).push({ operation: "owned_cli_cleanup", attempt: attempt + 1, reason: error instanceof Error ? error.name : "unknown" });
      if (error instanceof assert.AssertionError) throw new Error("fixture_owner_mismatch");
    }
  }
  const listed = await checked(["container", "ls", "--all", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"], 30_000);
  if (listed.split(/\r?\n/).includes(container)) throw new Error("fixture_cleanup_unconfirmed");
}

try {
  const verification = JSON.parse(await readFile(path.join(root, ".tools/cli-fixtures/verification.json"), "utf8"));
  for (const provider of ["codex", "claude"] as const) {
    const bytes = await readFile(path.join(root, ".tools/cli-fixtures", provider));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), provider === "claude" ? lock.claude.sha256 : lock.codex.binary_sha256);
  }
  assert.equal(verification.claude_manifest_signature_verified, true);
  assert.equal(verification.codex_sha256, lock.codex.sha256);
  assert.equal(verification.codex_binary_sha256, lock.codex.binary_sha256);
  report.binary_verification = verification;
  report.cli_binary_delivery = "checksum_verified_public_binary_tmpfs_or_owned_readonly_public_cache";
  report.base_image_size_bytes = Number(await checked(["image", "inspect", "--format", "{{.Size}}", base.image]));
  const only = process.env.CG_FIXTURE_PROVIDER;
  if (!only || only === "claude") await providerTest("claude");
  if (!only || only === "codex") await providerTest("codex");
} catch (error) {
  report.error = error instanceof Error ? error.message.slice(0, 500) : "cli_fixture_failed";
  console.log(`FAIL CLI fixture: ${report.error}`);
  process.exitCode = 1;
} finally {
  const failures: unknown[] = [];
  const removedContainers=new Set<string>();
  for (const child of children) { child.stdin.end(); child.kill(); }
  for (const runtime of runtimes) { try { await runtime.close(); } catch (error) { failures.push(error); } }
  for (const container of containers) {
    try { await closeCli(container);removedContainers.add(container); } catch (error) { failures.push(error); }
  }
  try {
    await checked(["info", "--format", "{{.ServerVersion}}"], 30_000);
  } catch (error) { failures.push(error); }
  report.cleanup_confirmed = failures.length === 0;
  report.cleanup_failure_codes = failures.map((error) => error instanceof Error ? error.message.slice(0, 100) : "unknown");
  const selected=process.env.CG_FIXTURE_PROVIDER?[process.env.CG_FIXTURE_PROVIDER]:["codex","claude"];
  report.selected_providers=selected;
  report.success = selected.every((provider) => report.providers[provider]?.status === "passed") && report.cleanup_confirmed;
  if (!report.cleanup_confirmed) process.exitCode = 1;
  if (!report.success) process.exitCode = 1;
  report.remaining = ["real subscription task execution/diff inside an isolated CLI/auth runtime and token renewal/logout", "all tool/plugin/subagent paths and adversarial transitions", "network allowlist with real providers", "cross-platform and crash recovery", "production API integration and security review"];
  // The read-only cache mount is still a profile consumer. Do not release its
  // claim until the fixture container is absent and profile proof is written.
  for(const cache of managedCaches){
    if(containers.includes(cache.container)&&!removedContainers.has(cache.container))continue;
    try{await cache.runtime.finishOperation();}catch{report.cleanup_confirmed=false;report.success=false;process.exitCode=1;}
  }
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Official CLI fixture success: ${report.success}; cleanup: ${report.cleanup_confirmed}`);
  console.log(`Report: ${path.join(directory, "report.json")}`);
}
