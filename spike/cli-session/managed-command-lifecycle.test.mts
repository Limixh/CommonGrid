import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedCliRuntime } from "./managed-runtime.mts";
import { managedSessionMain } from "./managed-session.mts";
import { acceptanceMain } from "./managed-session-acceptance.mts";
import { managedTaskMain, settleManagedTaskCallbacks } from "./managed-task.mts";
import { ProviderFailure } from "../../packages/agent-adapters/src/session-protocol.ts";

const directory=fileURLToPath(new URL("../../.local/managed-session/",import.meta.url));
// These fixture profiles are fresh public JSON files. All runtime entry points
// are replaced before invocation; no Docker, provider or model is contacted.
async function fixture(run:(value:{owner:string;manifest:string;calls:string[];runtime:ManagedCliRuntime})=>Promise<void>) {
  const owner=randomUUID(),manifest=path.join(directory,`${owner}.json`),calls:string[]=[];
  await mkdir(directory,{recursive:true});
  await writeFile(manifest,JSON.stringify({schema_version:"1.0",owner,provider:"claude",credential_files_copied:false})+"\n",{flag:"wx"});
  const runtime=ManagedCliRuntime.restore({owner,provider:"claude"});
  const original={prepare:ManagedCliRuntime.prepare,restore:ManagedCliRuntime.restore,begin:ManagedCliRuntime.prototype.beginOperation,start:ManagedCliRuntime.prototype.start,stop:ManagedCliRuntime.prototype.stop,finish:ManagedCliRuntime.prototype.finishOperation,install:ManagedCliRuntime.prototype.installTrustBundle,installHost:ManagedCliRuntime.prototype.installClaudeHostTrust};
  const priorExit=process.exitCode;
  ManagedCliRuntime.restore=()=>runtime;
  ManagedCliRuntime.prototype.beginOperation=async()=>{calls.push("claim");};
  ManagedCliRuntime.prototype.start=async()=>{calls.push("start");throw new ProviderFailure("process");};
  ManagedCliRuntime.prototype.stop=async()=>{calls.push("stop");};
  ManagedCliRuntime.prototype.finishOperation=async()=>{calls.push("finish");};
  ManagedCliRuntime.prototype.installTrustBundle=async()=>{calls.push("install");};
  try{await run({owner,manifest,calls,runtime});}
  finally{
    ManagedCliRuntime.prepare=original.prepare;ManagedCliRuntime.restore=original.restore;
    ManagedCliRuntime.prototype.beginOperation=original.begin;ManagedCliRuntime.prototype.start=original.start;
    ManagedCliRuntime.prototype.stop=original.stop;ManagedCliRuntime.prototype.finishOperation=original.finish;
    ManagedCliRuntime.prototype.installTrustBundle=original.install;ManagedCliRuntime.prototype.installClaudeHostTrust=original.installHost;process.exitCode=priorExit;
    await unlink(manifest).catch(error=>{if(error.code!=="ENOENT")throw error;});
  }
}

test("prepare publishes its identity while owned and releases on the early return",async()=>{
  await fixture(async({owner,manifest,calls,runtime})=>{
    await unlink(manifest);
    ManagedCliRuntime.prepare=async()=>{calls.push("prepare_claim");return runtime;};
    ManagedCliRuntime.prototype.finishOperation=async()=>{
      const published=JSON.parse(await readFile(manifest,"utf8"));
      assert.equal(published.owner,owner);assert.equal(published.credential_files_copied,false);
      calls.push("finish_after_manifest");
    };
    assert.equal(await managedSessionMain(["prepare","claude"]),owner);
    assert.deepEqual(calls,["prepare_claim","finish_after_manifest"]);
  });
});

test("prepare retains final cleanup on failed public manifest publication",async()=>{
  await fixture(async({manifest,calls,runtime})=>{
    // Existing directory blocks the write without changing another profile.
    await unlink(manifest);await mkdir(manifest);
    ManagedCliRuntime.prepare=async()=>runtime;
    try{await assert.rejects(()=>managedSessionMain(["prepare","claude"]));assert.deepEqual(calls,["finish"]);}
    finally{await rmdir(manifest);}
  });
});

test("installation owns the whole command and finishes on success or exception",async()=>{
  for(const fail of [false,true])await fixture(async({owner,calls})=>{
    ManagedCliRuntime.prototype.installTrustBundle=async()=>{calls.push("install");if(fail)throw Error("fixture_install_failed");};
    if(fail)await assert.rejects(()=>managedSessionMain(["install-trust","claude",owner]),/fixture_install_failed/);
    else await managedSessionMain(["install-trust","claude",owner]);
    assert.deepEqual(calls,["claim","install","finish"]);
  });
});

test("selected public trust is published before final ownership release",async()=>{
  await fixture(async({owner,manifest,calls,runtime})=>{
    const trust={schema_version:"1.0",kind:"optional_public_root",profile_owner:owner,purpose:"managed_claude_optional_public_root",endpoint:"api.anthropic.com:443",source:"operator_verified_tls_chain_and_installed_root",checked_at:new Date().toISOString(),certificate_sha256:"a".repeat(64),pem_sha256:"b".repeat(64)} as const;
    ManagedCliRuntime.prototype.installClaudeHostTrust=async()=>{calls.push("install_host_trust");runtime.identity=()=>({owner,provider:"claude",trust});};
    ManagedCliRuntime.prototype.finishOperation=async()=>{assert.deepEqual(JSON.parse(await readFile(manifest,"utf8")).trust,trust);calls.push("finish_after_trust_publish");};
    await managedSessionMain(["install-host-trust","claude",owner,"--host-trust-pem","fixture.pem","--host-trust-proof","fixture.json"]);
    assert.deepEqual(calls,["claim","install_host_trust","finish_after_trust_publish"]);
  });
});

test("manifest races fail before installation and still release the claimed operation",async()=>{
  await fixture(async({owner,manifest,calls})=>{
    ManagedCliRuntime.prototype.beginOperation=async()=>{calls.push("claim");const saved=JSON.parse(await readFile(manifest,"utf8"));await writeFile(manifest,JSON.stringify({...saved,created_at:new Date().toISOString()})+"\n");};
    await assert.rejects(()=>managedSessionMain(["install-trust","claude",owner]),/managed_public_manifest_changed/);
    assert.deepEqual(calls,["claim","finish"]);
  });
});

test("session status persists failed cleanup when durable release fails",async()=>{
  await fixture(async({owner,calls})=>{
    const filename=path.join(directory,`${owner}-status.report.json`);
    ManagedCliRuntime.prototype.finishOperation=async()=>{calls.push("finish");throw Error("fixture_release_failed");};
    try{
      const report=await managedSessionMain(["status","claude",owner]);
      const persisted=JSON.parse(await readFile(filename,"utf8"));
      assert.ok(report&&typeof report==="object");
      assert.equal(report.cleanup_confirmed,false);assert.equal(persisted.cleanup_confirmed,false);assert.equal(persisted.success,false);
      assert.deepEqual(calls,["claim","start","stop","finish"]);
    }finally{await unlink(filename);}
  });
});

test("acceptance persists final release failure without certifying cleanup",async()=>{
  await fixture(async({owner,calls})=>{
    ManagedCliRuntime.prototype.finishOperation=async()=>{calls.push("finish");throw Error("fixture_release_failed");};
    const result=await acceptanceMain(["claude",owner,"--real-account"]);
    try{
      const persisted=JSON.parse(await readFile(result.reportPath,"utf8"));
      assert.equal(persisted.cleanup_confirmed,false);assert.equal(persisted.success,false);assert.equal(result.operationsQuiescent,true);
      assert.deepEqual(calls,["claim","start","stop","finish"]);
    }finally{await unlink(result.reportPath);}
  });
});

test("acceptance retains its claim when canceled generic work ignores the signal",async()=>{
  await fixture(async({owner,calls})=>{
    ManagedCliRuntime.prototype.start=async()=>{
      calls.push("start");queueMicrotask(()=>process.emit("SIGINT"));return new Promise<void>(()=>{});
    };
    const result=await acceptanceMain(["claude",owner,"--real-account"]);
    try{
      assert.equal(result.operationsQuiescent,false);assert.equal(result.report.cleanup_confirmed,false);assert.equal(result.checkpoint,undefined);
      assert.deepEqual(calls,["claim","start","stop"]);
      const persisted=JSON.parse(await readFile(result.reportPath,"utf8"));assert.equal(persisted.cleanup_confirmed,false);
    }finally{await unlink(result.reportPath);}
  });
});

test("task callback observation rejects failures and bounds unresolved work",async()=>{
  assert.equal(await settleManagedTaskCallbacks(Promise.resolve()),true);
  assert.equal(await settleManagedTaskCallbacks(Promise.reject(Error("fixture_callback_failed"))),false);
  assert.equal(await settleManagedTaskCallbacks(new Promise(()=>{}),5),false);
});

test("managed task report includes durable release failure after namespace cleanup",async()=>{
  await fixture(async({owner,calls})=>{
    ManagedCliRuntime.prototype.finishOperation=async()=>{calls.push("finish");throw Error("fixture_release_failed");};
    // The fixture stops at start, before task allocation or official CLI calls.
    const taskDirectory=fileURLToPath(new URL("../../.local/managed-task/",import.meta.url));
    const before=new Set(await readdir(taskDirectory).catch(()=>[]));
    try{
      const report=await managedTaskMain(["claude",owner]);
      assert.equal(report.cleanup_confirmed,false);assert.equal(report.success,false);
      assert.deepEqual(calls,["claim","start","stop","finish"]);
      const created=(await readdir(taskDirectory)).filter(name=>!before.has(name));
      const matching:string[]=[];
      for(const name of created){
        if(!/^[0-9a-f-]{36}$/.test(name))continue;
        const filename=path.join(taskDirectory,name,"report.json");
        const persisted=JSON.parse(await readFile(filename,"utf8"));
        if(persisted.owner===owner){assert.equal(persisted.cleanup_confirmed,false);matching.push(filename);}
      }
      assert.equal(matching.length,1);
    }finally{
      for(const name of (await readdir(taskDirectory)).filter(name=>!before.has(name))){
        if(!/^[0-9a-f-]{36}$/.test(name))continue;
        const filename=path.join(taskDirectory,name,"report.json");
        const persisted=JSON.parse(await readFile(filename,"utf8"));
        if(persisted.owner!==owner)continue;
        await unlink(filename);await rmdir(path.dirname(filename));
      }
    }
  });
});
