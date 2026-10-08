import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TaskToolsRuntime, dockerCommand, DockerCommandError } from "../../packages/agent-adapters/src/task-runtime.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("image.lock.json", import.meta.url), "utf8"));
const runId = randomUUID();
const output = path.join(root, ".local/sandbox", runId);
await mkdir(output, { recursive: true });
const canary = `CG_FAKE_IDENTITY_${randomUUID()}`;
const hostCanaryPath = path.join(output, "fake-host-secret.txt");
await writeFile(hostCanaryPath, canary);
const authContainer = `cg-auth-fixture-${runId}`;
const authLabel = `io.commongrid.spike.owner=${runId}`;
let authCreated = false;
const runtimes: TaskToolsRuntime[] = [];
const checks: { name: string; passed: boolean; error?: string }[] = [];
const report: Record<string, any> = {
  schema_version: "1.0", checked_at: new Date().toISOString(), platform: process.platform,
  purpose: "live_fixture_task_container_attacks_no_cli_or_account", image: lock.image,
  execution_enabled: false, real_account_tested: false, isolation_gate: "not_evaluated",
  task_tools_boundary: "not_evaluated", checks, cleanup_confirmed: false,
  remaining: ["actual CLI/auth OS boundary and all tool paths", "MCP/control-channel authorization and confinement", "real account/diff and token renewal/logout", "provider compatibility", "macOS/Linux host matrix", "independent security review"],
};

async function checked(args: string[], timeoutMs = 10_000) {
  const result = await dockerCommand(args, { timeoutMs });
  assert.equal(result.code, 0, "Docker fixture operation failed");
  return result.stdout.trim();
}
async function check(name: string, action: () => Promise<void>) {
  try { await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    checks.push({ name, passed: false, error: error instanceof DockerCommandError ? error.message : "assertion_failed" });
    console.log(`FAIL ${name}`);
    throw error;
  }
}
async function create() {
  const runtime = await TaskToolsRuntime.create({ image: lock.image, cpu: 1, memoryMb: 256 });
  runtimes.push(runtime);
  return runtime;
}
async function nodeJSON(runtime: TaskToolsRuntime, source: string) {
  const result = await runtime.exec(["node", "-e", source]);
  assert.equal(result.code, 0, "fixture process failed");
  return JSON.parse(result.stdout);
}
async function detachedChild(runtime: TaskToolsRuntime) {
  const child = await nodeJSON(runtime, "const cp=require('node:child_process');const child=cp.spawn('/bin/sleep',['300'],{detached:true,stdio:'ignore'});child.once('spawn',()=>console.log(JSON.stringify({pid:child.pid})));child.unref();");
  assert.ok(Number.isInteger(child.pid) && child.pid > 1);
  const running = await nodeJSON(runtime, `process.kill(${child.pid},0);console.log(JSON.stringify(true));`);
  assert.equal(running, true); // Prove a real detached child exists before stop.
}
async function cleanup() {
  const errors: unknown[] = [];
  for (const runtime of runtimes) { try { await runtime.close(); } catch (error) { errors.push(error); } }
  if (authCreated) {
    try {
      const owner = await checked(["inspect", "--format", '{{index .Config.Labels "io.commongrid.spike.owner"}}', authContainer]);
      assert.equal(owner, runId);
      await checked(["rm", "--force", authContainer]);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error("fixture_cleanup_unconfirmed");
}

try {
  const info = JSON.parse(await checked(["info", "--format", '{{json .}}']));
  assert.equal(info.OSType, "linux", "Linux containers required");
  report.engine = { server_version: info.ServerVersion, os: info.OSType, architecture: info.Architecture };
  console.log("Pulling the pinned fixture image if needed...");
  await checked(["pull", lock.image], 180_000);
  report.resolved_image_id = await checked(["image", "inspect", "--format", "{{.Id}}", lock.image]);
  // A fake auth identity has its own PID namespace and tmpfs; no personal
  // identity directory is read or mounted. This is not an official CLI runtime.
  await checked(["create", "--name", authContainer, "--label", authLabel,
    "--network", "none", "--read-only", "--user", "65532:65532", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "16", "--memory", "128m",
    "--tmpfs", "/auth:rw,noexec,nosuid,size=1m,mode=0700,uid=65532,gid=65532",
    "--env", `CG_FAKE_TOKEN=${canary}`, lock.image, "node", "-e",
    "require('node:fs').writeFileSync('/auth/token.txt', process.env.CG_FAKE_TOKEN); setInterval(() => {}, 1000)"]);
  authCreated = true;
  await checked(["start", authContainer]);
  const authReady = await checked(["exec", authContainer, "node", "-e", "const fs=require('node:fs');console.log(fs.readFileSync('/auth/token.txt','utf8')===process.env.CG_FAKE_TOKEN)"]);
  assert.equal(authReady, "true");
  const runtime = await create();

  await check("runtime policy and resource limits", async () => {
    const state = await runtime.inspect();
    assert.equal(state.Config.User, "65532:65532");
    assert.equal(state.HostConfig.NetworkMode, "none");
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(state.HostConfig.CapDrop, ["ALL"]);
    assert.equal(state.HostConfig.Privileged, false);
    assert.ok(state.HostConfig.SecurityOpt.includes("no-new-privileges"));
    assert.equal(state.HostConfig.Memory, 256 * 1024 * 1024);
    assert.equal(state.HostConfig.MemorySwap, state.HostConfig.Memory);
    assert.equal(state.HostConfig.NanoCpus, 1_000_000_000);
    assert.equal(state.HostConfig.PidsLimit, 128);
    assert.ok(!["host", "container"].some((mode) => state.HostConfig.PidMode.startsWith(mode)));
    assert.equal(state.HostConfig.Init, true);
    const volumes = state.Mounts.filter((mount: any) => mount.Type !== "tmpfs");
    assert.equal(volumes.length, 1);
    assert.equal(volumes[0].Type, "volume");
    assert.equal(volumes[0].Name, runtime.volume);
    assert.equal(volumes[0].Destination, "/task");
  });

  await check("task writes succeed and root filesystem writes fail", async () => {
    const actual = await nodeJSON(runtime, `const fs=require('node:fs'); fs.writeFileSync('/task/result.txt','fixture result'); let denied=false; try { fs.writeFileSync('/etc/cg-fixture','x'); } catch(e) { denied=['EROFS','EACCES'].includes(e.code); } console.log(JSON.stringify({uid:process.getuid(), text:fs.readFileSync('/task/result.txt','utf8'),denied}));`);
    assert.deepEqual(actual, { uid: 65532, text: "fixture result", denied: true });
  });

  await check("kernel cgroup limits match the declared task limits", async () => {
    const actual = await nodeJSON(runtime, "const fs=require('node:fs');console.log(JSON.stringify(Object.fromEntries(['memory.max','pids.max','cpu.max'].map(name=>[name,fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim()]))))");
    assert.equal(actual["memory.max"], String(256 * 1024 * 1024));
    assert.equal(actual["pids.max"], "128");
    const [quota, period] = actual["cpu.max"].split(" ").map(Number);
    assert.equal(quota / period, 1);
  });

  await check("host paths, auth canary, daemon socket and traversal cannot reveal secrets", async () => {
    const paths = ["/auth/token.txt", "/var/run/docker.sock", "/run/docker.sock", "/root/.claude/.credentials.json", hostCanaryPath, "/task/../../auth/token.txt", "/proc/1/root/auth/token.txt"];
    const actual = await nodeJSON(runtime, `const fs=require('node:fs'); const paths=${JSON.stringify(paths)}; fs.symlinkSync('/auth/token.txt','/task/secret-link'); paths.push('/task/secret-link'); console.log(JSON.stringify(paths.map(p=>{try{return{read:true,data:fs.readFileSync(p,'utf8')}}catch{return{read:false}}})));`);
    assert.ok(actual.every((item: any) => !item.read));
  });

  await check("proc and environment cannot expose the separate fake CLI identity", async () => {
    const actual = await nodeJSON(runtime, `const fs=require('node:fs'); let data=JSON.stringify(process.env); const pids=fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)); for(const pid of pids) for(const file of ['environ','cmdline']) { try{data+=fs.readFileSync('/proc/'+pid+'/'+file,'utf8')}catch{}} console.log(JSON.stringify({data,pidCount:pids.length,status:fs.readFileSync('/proc/self/status','utf8')}));`);
    assert.ok(!actual.data.includes(canary));
    assert.ok(!actual.data.includes("CG_FAKE_TOKEN"));
    assert.match(actual.status, /CapEff:\s+0000000000000000/);
    assert.match(actual.status, /NoNewPrivs:\s+1/);
    assert.match(actual.status, /Seccomp:\s+2/);
    assert.ok(actual.pidCount < 16);
  });

  await check("outbound network is blocked", async () => {
    const actual = await nodeJSON(runtime, `const net=require('node:net'); const socket=net.connect({host:'1.1.1.1',port:443}); let finished=false; function done(connected){if(finished)return;finished=true;socket.destroy();console.log(JSON.stringify({connected}));} socket.on('connect',()=>done(true));socket.on('error',()=>done(false));socket.setTimeout(500,()=>done(false));`);
    assert.equal(actual.connected, false);
  });

  await check("tmpfs executable and privileged namespace operations are denied", async () => {
    const actual = await nodeJSON(runtime, `const fs=require('node:fs');const cp=require('node:child_process');fs.writeFileSync('/tmp/cg-script',${JSON.stringify("#!/bin/sh\nexit 0\n")},{mode:0o755}); const exec=cp.spawnSync('/tmp/cg-script');const ns=cp.spawnSync('/usr/bin/unshare',['--mount','/bin/true']);console.log(JSON.stringify({execDenied:exec.error?.code==='EACCES',namespaceDenied:ns.status!==0}));`);
    assert.deepEqual(actual, { execDenied: true, namespaceDenied: true });
  });

  await check("child process exhaustion is bounded by the PID cgroup", async () => {
    const actual = await nodeJSON(runtime, `const cp=require('node:child_process');const children=[];let denied=false;function next(){if(children.length>=150)return finish();const child=cp.spawn('/bin/sleep',['30']);child.once('spawn',()=>{children.push(child);next()});child.once('error',e=>{denied=e.code==='EAGAIN';finish()});}function finish(){for(const child of children)child.kill('SIGKILL');console.log(JSON.stringify({denied,count:children.length}));}next();`);
    assert.equal(actual.denied, true);
    assert.ok(actual.count < 128);
  });

  await check("opaque workspace does not retain an earlier attempt", async () => {
    const second = await create();
    const actual = await nodeJSON(second, "console.log(JSON.stringify(require('node:fs').existsSync('/task/result.txt')))" );
    assert.equal(actual, false);
    await second.close();
  });

  await check("deadline stops a command and its detached child process tree", async () => {
    const timed = await create();
    await detachedChild(timed);
    await assert.rejects(timed.exec(["node", "-e", "setInterval(()=>{},1000)"], { timeoutMs: 600 }), (error: any) => error instanceof DockerCommandError && error.reason === "timeout");
    const absent = await dockerCommand(["inspect", timed.container]);
    assert.notEqual(absent.code, 0);
    await assert.rejects(timed.exec(["/bin/true"]), /sandbox_unavailable/);
  });

  await check("cancellation stops the entire task environment", async () => {
    const cancelled = await create();
    await detachedChild(cancelled);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    try {
      await assert.rejects(cancelled.exec(["node", "-e", "setInterval(()=>{},1000)"], { signal: controller.signal }), (error: any) => error instanceof DockerCommandError && error.reason === "cancelled");
    } finally { clearTimeout(timer); }
    assert.notEqual((await dockerCommand(["inspect", cancelled.container])).code, 0);
  });

  await check("unbounded tool output stops the task without forwarding the output", async () => {
    const verbose = await create();
    await assert.rejects(verbose.exec(["node", "-e", "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"], { maxBytes: 1024 }), (error: any) => error instanceof DockerCommandError && error.reason === "output_limit");
    assert.notEqual((await dockerCommand(["inspect", verbose.container])).code, 0);
  });
  report.task_tools_boundary = "fixture_tests_passed";
} catch (error) {
  report.error = "sandbox_fixture_failed";
  report.error_kind = error instanceof DockerCommandError ? error.reason : error instanceof Error ? error.name : "unknown";
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
    for (const runtime of runtimes) {
      assert.notEqual((await dockerCommand(["inspect", runtime.container])).code, 0);
      assert.notEqual((await dockerCommand(["volume", "inspect", runtime.volume])).code, 0);
    }
    const engine = await dockerCommand(["info", "--format", "{{.ServerVersion}}"]);
    assert.equal(engine.code, 0); // Missing engine must not count as cleanup.
    report.cleanup_confirmed = true;
  } catch { report.cleanup_error = "sandbox_cleanup_unconfirmed"; process.exitCode = 1; }
  report.passed = checks.filter((check) => check.passed).length;
  report.failed = checks.filter((check) => !check.passed).length;
  report.success = report.task_tools_boundary === "fixture_tests_passed" && report.cleanup_confirmed;
  report.owned_containers = [authContainer, ...runtimes.map((runtime) => runtime.container)];
  report.owned_volumes = runtimes.map((runtime) => runtime.volume);
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Sandbox fixture: ${report.passed} passed; cleanup confirmed: ${report.cleanup_confirmed}`);
  console.log(`Report: ${path.join(output, "report.json")}`);
}
