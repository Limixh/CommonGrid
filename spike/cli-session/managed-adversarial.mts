// F0 adversarial acceptance. Fresh synthetic profiles only, no login/inference
// and no existing managed homes. The parent runner coordinates Docker runs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedCliRuntime, startBridge, checked, taskImage } from "./managed-runtime.mts";
import { TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
import { executeTaskTool } from "../../packages/agent-adapters/src/task-tool.ts";
import { separationProbe, resourceProbe } from "./managed-probes.mjs";

const selected = process.argv.slice(2);
assert.ok(selected.every(value => value === "claude" || value === "codex"), "managed_adversarial_provider_invalid");
const providers = selected.length ? [...new Set(selected)] as ("claude" | "codex")[] : ["claude", "codex"] as const;
const directory = fileURLToPath(new URL(`../../.local/managed-adversarial/${randomUUID()}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const report: Record<string, any> = { checked_at: new Date().toISOString(), purpose: "synthetic_malicious_task_and_control_acceptance", synthetic_profiles_only: true, real_account_tested: false, real_model_inference: false, credential_files_copied: false, existing_private_profiles_accessed: false, execution_enabled: false, isolation_gate: "not_evaluated", providers: {}, cleanup_confirmed: false, scope_limits: ["pinned Linux x86-64 Docker image only", "synthetic canaries; no real credential extraction test", "workspace volume has no disk quota", "memory/CPU limits inspected, not OOM/CPU stress acceptance", "Docker daemon/kernel/host compromise not evaluated", "provider extension paths not exhaustively evaluated"] };
let cleanup = true;
for (const provider of providers) {
  const checks: string[] = [], tasks: TaskToolsRuntime[] = [];
  const evidence: Record<string, any> = { status: "running", checks }; report.providers[provider] = evidence;
  let runtime: ManagedCliRuntime | undefined, bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let stage = "fresh_synthetic_prepare";
  try {
    runtime = await ManagedCliRuntime.prepare(provider); await runtime.start();
    const newTask = async () => { const task = await TaskToolsRuntime.create({ image: taskImage, cpu: 1, memoryMb: 256 }, 300_000); tasks.push(task); return task; };
    const task = await newTask(), sibling = await newTask();
    const canary = `CG_SYNTHETIC_${randomUUID()}`;
    stage = "private_canary_setup";
    const daemon = "const f=require('node:fs'),n=require('node:net');process.title='cg-synthetic-private-daemon';const fd=f.openSync('/home/node/cg-synthetic-private/canary','r');const unix=n.createServer(s=>s.end('synthetic')).listen('/home/node/cg-synthetic-private/daemon.sock');const tcp=n.createServer(s=>s.end('synthetic')).listen(19876,'127.0.0.1',()=>f.writeFileSync('/home/node/cg-synthetic-private/ready.json',JSON.stringify({pid:process.pid,fd})));setInterval(()=>{},1000);";
    const setup = await runtime.exec(["node", "-e", `const f=require('node:fs'),cp=require('node:child_process');f.mkdirSync('/home/node/cg-synthetic-private',{mode:0o700});f.writeFileSync('/home/node/cg-synthetic-private/canary',${JSON.stringify(canary)},{mode:0o600});const child=cp.spawn('node',['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore',env:{...process.env,CG_SYNTHETIC_PRIVATE_CANARY:${JSON.stringify(canary)}}});child.unref();`]); assert.equal(setup.code, 0);
    const privateInfo = await runtime.exec(["node", "-e", "const f=require('node:fs');let attempts=0;const timer=setInterval(()=>{try{const data=f.readFileSync('/home/node/cg-synthetic-private/ready.json','utf8');clearInterval(timer);console.log(data);}catch{if(++attempts>40){clearInterval(timer);process.exit(1);}}},50);"]);
    assert.equal(privateInfo.code, 0); const { pid: privatePid } = JSON.parse(privateInfo.stdout);
    const cliNamespaces = JSON.parse((await runtime.exec(["node", "-e", "const f=require('node:fs');console.log(JSON.stringify(['pid','mnt','net'].map(n=>f.readlinkSync('/proc/1/ns/'+n))))"])).stdout);
    const taskNamespaces = JSON.parse((await task.exec(["node", "-e", "const f=require('node:fs');console.log(JSON.stringify(['pid','mnt','net'].map(n=>f.readlinkSync('/proc/1/ns/'+n))))"])).stdout);
    assert.ok(cliNamespaces.every((value: string, index: number) => value !== taskNamespaces[index])); checks.push("distinct_pid_mount_network_namespaces");
    const info = await task.inspect();
    assert.equal(info.HostConfig.NetworkMode, "none"); assert.equal(info.HostConfig.ReadonlyRootfs, true); assert.equal(info.Config.User, "65532:65532");
    assert.deepEqual(info.HostConfig.CapDrop, ["ALL"]); assert.ok(info.HostConfig.SecurityOpt.includes("no-new-privileges"));
    assert.equal(info.HostConfig.PidsLimit, 128); assert.equal(info.HostConfig.Memory, 268_435_456); assert.equal(info.HostConfig.MemorySwap, 268_435_456); assert.equal(info.HostConfig.NanoCpus, 1_000_000_000);
    assert.ok(info.Mounts.every((mount: any) => mount.Type === "volume" && mount.Name === task.volume && mount.Destination === "/task")); checks.push("task_uid_caps_readonly_mounts_and_cgroup_limits");
    stage = "task_separation_probe";
    const separation = await task.exec(["node", "-e", `(${separationProbe.toString()})(${JSON.stringify(canary)},${privatePid}).catch(()=>process.exit(1))`], { timeoutMs: 15_000 });
    assert.equal(separation.code, 0); evidence.separation = JSON.parse(separation.stdout); assert.ok(Object.values(evidence.separation).every(value => value === true)); checks.push("malicious_filesystem_process_fd_env_socket_ptrace_probes");
    stage = "pid_and_tmpfs_exhaustion";
    const resources = await task.exec(["node", "-e", `(${resourceProbe.toString()})().catch(()=>process.exit(1))`], { timeoutMs: 20_000 });
    assert.equal(resources.code, 0); evidence.resources = JSON.parse(resources.stdout); assert.equal(evidence.resources.tmpfs_bounded, true); assert.equal(evidence.resources.pids_bounded, true); assert.ok(evidence.resources.children_started < 128); checks.push("pid_and_tmpfs_exhaustion_bounded");
    await sibling.exec(["node", "-e", "require('node:fs').writeFileSync('/task/cg-attempt-canary','intact')"]);
    bridge = await startBridge(runtime, task);
    stage = "proxy_destination_denials";
    const proxy = await runtime.exec(["node", "-e", "const n=require('node:net');Promise.all(['example.com:443','127.0.0.1:443','169.254.169.254:443','auth.openai.com:80'].map(authority=>new Promise(resolve=>{let received='';const s=n.connect(9877,'127.0.0.1',()=>s.write('CONNECT '+authority+' HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n'));s.on('data',d=>received+=d);s.on('error',()=>{});s.on('close',()=>resolve(!received.includes('200 Connection Established')));s.setTimeout(2000,()=>s.destroy());}))).then(v=>console.log(JSON.stringify(v)));"], 10_000);
    assert.equal(proxy.code, 0); assert.deepEqual(JSON.parse(proxy.stdout), [true, true, true, true]); assert.equal(bridge.stats.denied, 4); checks.push("unknown_ip_metadata_plaintext_proxy_destinations_denied");
    stage = "malformed_broker_and_attempt_scope";
    const broker = await runtime.exec(["node", "-e", `(async()=>{const url='http://127.0.0.1:9876/task',headers={authorization:'Bearer '+process.env.CG_TOOL_TOKEN};const requests=[{body:'{',headers},{body:'{}',headers:{authorization:'Bearer wrong'}},{body:' '.repeat(49153),headers},{body:JSON.stringify({argv:['node','-e',\"require('node:fs').writeFileSync('/task/cg-attempt-canary','escaped')\"],container:${JSON.stringify(sibling.container)}}),headers},{body:JSON.stringify({argv:['node','-e','process.exit(0)'],env:{CG_TOOL_TOKEN:'steal'}}),headers},{body:JSON.stringify({argv:['node','-e','process.exit(0)'],cwd:'/home/node'}),headers},{body:JSON.stringify({argv:['--privileged']}),headers},{body:JSON.stringify({argv:['/bin/true'],timeout_ms:30001}),headers}];const out=[];for(const options of requests){const r=await fetch(url,{method:'POST',...options});out.push({status:r.status,...(r.headers.get('content-type')?.includes('application/json')?{result:await r.json()}: {})});}console.log(JSON.stringify(out));})().catch(()=>process.exit(1));`], 15_000);
    assert.equal(broker.code, 0); const brokerResults = JSON.parse(broker.stdout); assert.deepEqual(brokerResults.slice(0, 3).map((item: any) => item.status), [400, 401, 413]);
    assert.ok(brokerResults.slice(3).every((item: any) => item.result?.error === "task_tool_failed"));
    assert.equal((await sibling.exec(["node", "-e", "console.log(require('node:fs').readFileSync('/task/cg-attempt-canary','utf8'))"])).stdout.trim(), "intact"); checks.push("broker_malformed_auth_size_arguments_attempt_scope_denied");
    stage = "broker_output_and_call_budget";
    const oversized = await runtime.exec(["node", "-e", "(async()=>{const r=await fetch('http://127.0.0.1:9876/task',{method:'POST',headers:{authorization:'Bearer '+process.env.CG_TOOL_TOKEN},body:JSON.stringify({argv:['node','-e',\"process.stdout.write('x'.repeat(60000))\"]})});console.log(JSON.stringify(await r.json()));})().catch(()=>process.exit(1))"]); assert.deepEqual(JSON.parse(oversized.stdout), { error: "task_output_limit" }); checks.push("broker_task_result_output_limit");
    const remaining = 16 - bridge.stats.task_calls;
    const budget = await runtime.exec(["node", "-e", `(async()=>{const call=async argv=>(await fetch('http://127.0.0.1:9876/task',{method:'POST',headers:{authorization:'Bearer '+process.env.CG_TOOL_TOKEN},body:JSON.stringify({argv})})).json();for(let i=0;i<${remaining};i++)if((await call(['/bin/true'])).exit_code!==0)process.exit(1);console.log(JSON.stringify(await call(['node','-e',\"require('node:fs').writeFileSync('/task/cg-after-budget','forbidden')\"])));})().catch(()=>process.exit(1))`], 30_000);
    assert.equal(budget.code, 0); assert.deepEqual(JSON.parse(budget.stdout), { error: "task_call_limit" }); assert.equal(bridge.stats.task_calls, 16);
    assert.equal((await task.exec(["node", "-e", "console.log(require('node:fs').existsSync('/task/cg-after-budget'))"])).stdout.trim(), "false"); checks.push("broker_call_limit_blocks_side_effects");
    const daemonAlive = await runtime.exec(["node", "-e", `const f=require('node:fs');console.log(f.readFileSync('/home/node/cg-synthetic-private/canary','utf8')===${JSON.stringify(canary)}&&process.kill(${privatePid},0));`]);
    // process.kill(pid, 0) returns true after verifying the synthetic process.
    assert.equal(daemonAlive.stdout.trim(), "true"); checks.push("private_canary_and_process_intact_after_attacks");
    stage = "task_deadline_namespace_teardown";
    const timeoutTask = await newTask(); assert.deepEqual(await executeTaskTool(timeoutTask, { argv: ["node", "-e", "setInterval(()=>{},1000)"], timeout_ms: 80 }), { error: "task_tool_failed" }); await assert.rejects(() => timeoutTask.exec(["/bin/true"])); checks.push("deadline_exhaustion_tears_down_task_namespace");
    stage = "task_output_namespace_teardown";
    const outputTask = await newTask(); assert.deepEqual(await executeTaskTool(outputTask, { argv: ["node", "-e", "process.stdout.write('x'.repeat(2097152))"] }), { error: "task_tool_failed" }); await assert.rejects(() => outputTask.exec(["/bin/true"])); checks.push("output_exhaustion_tears_down_task_namespace");
    evidence.control = bridge.stats; assert.equal(bridge.stats.control_failure, false); evidence.status = "passed";
    console.log(`PASS ${provider}: ${checks.length} synthetic adversarial acceptance groups`);
  } catch { evidence.status = "failed"; evidence.failed_stage = stage; process.exitCode = 1; console.log(`FAIL ${provider}: ${stage}`); }
  finally {
    bridge?.close();
    let taskCleanup=true;
    // Only fresh owner-labeled objects created by this invocation are removed.
    for (const task of tasks) { try { await task.close(); } catch { taskCleanup=false;cleanup = false; process.exitCode = 1; } }
    if (runtime) {
      try {
        if(taskCleanup){await runtime.destroy();for (const volume of [runtime.authVolume, runtime.toolsVolume]) assert.ok(!(await checked(["volume", "ls", "--format", "{{.Name}}"])).split(/\r?\n/).includes(volume));}
        else await runtime.stop(); // Unconfirmed task work retains the durable claim.
      } catch { cleanup = false; process.exitCode = 1; }
    }
  }
}
report.cleanup_confirmed = cleanup; report.success = cleanup && providers.every(provider => report.providers[provider].status === "passed");
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(`Report: ${path.join(directory, "report.json")}`);
