// Real public HTTPS reachability + fake auth boundary. No login/inference.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedCliRuntime, startBridge, checked, taskImage } from "./managed-runtime.mts";
import { TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
const [claudeOwner,codexOwner]=process.argv.slice(2);
const directory=fileURLToPath(new URL(`../../.local/managed-boundary/${randomUUID()}/`,import.meta.url));await mkdir(directory,{recursive:true});
const report:Record<string,any>={checked_at:new Date().toISOString(),purpose:"managed_runtime_fake_auth_and_public_tls_boundary",real_account_tested:false,real_model_inference:false,credential_files_copied:false,execution_enabled:false,isolation_gate:"not_evaluated",providers:{},cleanup_confirmed:false,private_volumes_retained:true};
let cleanup=true;
for(const provider of ["claude","codex"] as const) {
  const runtime=ManagedCliRuntime.restore({owner:provider === "claude"?claudeOwner:codexOwner,provider});
  const task=await TaskToolsRuntime.create({image:taskImage,cpu:1,memoryMb:256},300_000);
  let bridge:Awaited<ReturnType<typeof startBridge>>|undefined;
  const checks:string[]=[];report.providers[provider]={checks,status:"running"};
  const canary=`CG_PRIVATE_${randomUUID()}`;
  try {
    const start=performance.now();await runtime.start();report.providers[provider].warm_cli_start_ms=Math.round(performance.now()-start);
    bridge=await startBridge(runtime,task);
    const info=JSON.parse(await checked(["inspect",runtime.container]))[0];
    assert.equal(info.HostConfig.NetworkMode,"none");assert.equal(info.HostConfig.ReadonlyRootfs,true);assert.equal(info.Config.User,"1000:1000");
    assert.ok(info.Mounts.every((mount:any)=>mount.Type==="volume"));assert.equal(info.Mounts.find((mount:any)=>mount.Destination==="/opt/cg").RW,false);assert.equal(info.Mounts.find((mount:any)=>mount.Destination==="/home/node").Name,runtime.authVolume);checks.push("network_none_no_host_mounts_readonly_tools");
    const competitor=ManagedCliRuntime.restore(runtime.identity());await assert.rejects(()=>competitor.start());await competitor.stop();
    assert.equal((await runtime.exec(["node","-e","console.log('incumbent_alive')"])).stdout.trim(),"incumbent_alive");checks.push("competing_profile_command_cannot_delete_incumbent");
    assert.equal((await runtime.exec(["node","-e",`require('node:fs').writeFileSync('/home/node/cg-private-canary',${JSON.stringify(canary)},{mode:0o600});`])).code,0);
    const isolation=await task.exec(["node","-e","const f=require('node:fs'),n=require('node:net');let denied=false;try{f.readFileSync('/home/node/cg-private-canary')}catch{denied=true}const env=JSON.stringify(process.env)+f.readFileSync('/proc/1/environ','utf8');const s=n.connect({host:'127.0.0.1',port:9877});s.on('connect',()=>{s.destroy();console.log(JSON.stringify({denied,env_absent:!env.includes('CG_TOOL_TOKEN'),proxy_unreachable:false}))});s.on('error',()=>console.log(JSON.stringify({denied,env_absent:!env.includes('CG_TOOL_TOKEN'),proxy_unreachable:true})));s.setTimeout(500,()=>s.destroy());"]);
    assert.equal(isolation.code,0);assert.deepEqual(JSON.parse(isolation.stdout),{denied:true,env_absent:true,proxy_unreachable:true});checks.push("task_cannot_read_auth_env_or_use_proxy");
    const denied=await runtime.exec(["node","-e","const n=require('node:net');Promise.all(['example.com:443','127.0.0.1:443','auth.openai.com:80'].map(authority=>new Promise(resolve=>{let received='';const s=n.connect(9877,'127.0.0.1',()=>s.write('CONNECT '+authority+' HTTP/1.1\\r\\nHost: '+authority+'\\r\\n\\r\\n'));s.on('data',d=>received+=d);s.on('error',()=>{});s.on('close',()=>resolve(!received.includes('200 Connection Established')));s.setTimeout(3000,()=>s.destroy());}))).then(v=>console.log(JSON.stringify(v)));"],10_000);
    assert.deepEqual(JSON.parse(denied.stdout),[true,true,true]);checks.push("unknown_domain_ip_and_plaintext_port_denied");
    const hostname=provider === "codex"?"auth.openai.com":"platform.claude.com";
    const tlsScript=`const n=require('node:net'),tls=require('node:tls');const host=${JSON.stringify(hostname)};const s=n.connect(9877,'127.0.0.1',()=>s.write('CONNECT '+host+':443 HTTP/1.1\\r\\nHost: '+host+':443\\r\\n\\r\\n'));let data='';s.setTimeout(10000,()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(1));s.on('data',function header(b){data+=b;const at=data.indexOf('\\r\\n\\r\\n');if(at<0)return;s.removeListener('data',header);if(!data.startsWith('HTTP/1.1 200'))process.exit(1);const rest=Buffer.from(data.slice(at+4));if(rest.length)s.unshift(rest);s.setTimeout(0);const t=tls.connect({socket:s,servername:host,rejectUnauthorized:true},()=>{console.log(JSON.stringify({tls_authorized:t.authorized}));t.destroy();});t.setTimeout(10000,()=>{t.destroy();process.exit(1)});t.on('error',()=>process.exit(1));});`;
    const tls=await runtime.exec(["node","-e",tlsScript],25_000);assert.equal(tls.code,0);assert.deepEqual(JSON.parse(tls.stdout),{tls_authorized:true});checks.push("provider_tls_passthrough_certificate_verified");
    const broker=await runtime.exec(["node","-e","(async()=>{const url='http://127.0.0.1:9876/task';const a=await fetch(url,{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'});const b=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+process.env.CG_TOOL_TOKEN},body:JSON.stringify({argv:['node','-e','console.log(7)'],container:'another-attempt'})});const c=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+process.env.CG_TOOL_TOKEN},body:JSON.stringify({argv:['node','-e','console.log(7)']})});console.log(JSON.stringify({wrong_token:a.status,wrong_scope:(await b.json()).error,value:JSON.parse(JSON.stringify(await c.json())).stdout.trim()}))})();"]);
    assert.deepEqual(JSON.parse(broker.stdout),{wrong_token:401,wrong_scope:"task_tool_failed",value:"7"});checks.push("broker_auth_attempt_scope_and_real_task_roundtrip");
    const budget=await runtime.exec(["node","-e","(async()=>{const call=async argv=>(await fetch('http://127.0.0.1:9876/task',{method:'POST',headers:{authorization:'Bearer '+process.env.CG_TOOL_TOKEN},body:JSON.stringify({argv})})).json();for(let i=0;i<14;i++)if((await call(['/bin/true'])).exit_code!==0)process.exit(1);console.log(JSON.stringify(await call(['node','-e',\"require('node:fs').writeFileSync('/task/overflow','forbidden')\"])));})();"],20_000);
    assert.equal(budget.code,0);assert.deepEqual(JSON.parse(budget.stdout),{error:"task_call_limit"});assert.equal(bridge.stats.task_calls,16);
    assert.equal((await task.exec(["node","-e","console.log(require('node:fs').existsSync('/task/overflow'))"])).stdout.trim(),"false");checks.push("task_call_budget_denies_execution_after_limit");
    bridge.close();await runtime.stop();await runtime.start();
    const restored=await runtime.exec(["node","-e",`const f=require('node:fs');console.log(f.readFileSync('/home/node/cg-private-canary','utf8')===${JSON.stringify(canary)});f.unlinkSync('/home/node/cg-private-canary');`]);assert.equal(restored.stdout.trim(),"true");checks.push("private_home_survives_cli_restart");
    report.providers[provider].status="passed";report.providers[provider].network=bridge.stats;console.log(`PASS ${provider}: ${checks.length} managed-runtime boundary checks`);
  }catch {report.providers[provider].status="failed";process.exitCode=1;console.log(`FAIL ${provider}: managed-runtime boundary after ${checks.length} checks`);}
  finally{bridge?.close();try{await runtime.stop();await task.close();}catch{cleanup=false;process.exitCode=1;}}
}
report.cleanup_confirmed=cleanup;report.success=cleanup&&["claude","codex"].every(p=>report.providers[p].status==="passed");
await writeFile(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");console.log(`Report: ${path.join(directory,"report.json")}`);
