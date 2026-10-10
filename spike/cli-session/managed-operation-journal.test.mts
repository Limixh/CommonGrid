import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOperationJournal, readOperationJournals } from "../../packages/agent-adapters/src/operation-journal.ts";
import type { OperationJournal, JournalReceipt } from "../../packages/agent-adapters/src/operation-journal-types.ts";
import { DockerCommandError } from "../../packages/agent-adapters/src/task-runtime.ts";
import { ManagedCliRuntime, type ManagedContainerEvidence, type ManagedJournalOptions } from "./managed-runtime.mts";

type Fixture = Awaited<ReturnType<typeof makeFixture>>;
const fixtureTempRoot=await realpath(tmpdir());
async function makeFixture(directory: string, journalFactory?: ManagedJournalOptions["journalFactory"]) {
  const owner=randomUUID(), leaseId="c".repeat(64), commands:string[][]=[];
  const runtime=ManagedCliRuntime.restore({owner,provider:"claude"},{journalRoot:directory,...(journalFactory ? {journalFactory} : {})});
  const pins=JSON.parse(await readFile(new URL("binaries.lock.json",import.meta.url),"utf8"));
  const hashes=new Map(await Promise.all(["runtime-bridge.mjs","tunnel-wire.mjs","mcp.mjs","task-broker.mjs"].map(async name => [name,createHash("sha256").update(await readFile(new URL(`../../packages/agent-adapters/runtime-assets/${name}`,import.meta.url))).digest("hex")] as const)));
  let leasePresent=false, namespaceId:string|undefined, nextId=10, failCreate=false, late=false;
  const leaseName=`cg-managed-lease-${owner}`;
  (runtime as any).command=async(args:string[]) => {
    commands.push(args);
    if(args[0] === "create" && args.includes(leaseName)) {
      assert.ok(runtime.journalSnapshot()?.pending.some(intent => intent.action === "lease_acquire"),"fixture_intent_before_lease_create");
      leasePresent=true; return leaseId;
    }
    if(args[0] === "inspect" && [leaseName,leaseId].includes(args.at(-1)!)) {
      assert.ok(leasePresent,"fixture_lease_missing");
      return JSON.stringify({id:leaseId,name:`/${leaseName}`,owner,provider:"claude",operation:runtime.operationIdentity().operation,kind:"managed-profile-claim",schema:"1",running:false,status:"created",network:"none",readonly:true,mounts:0,ports:0});
    }
    if(args.includes(`name=^/${leaseName}$`)) return leasePresent ? leaseName : "";
    if(args.includes(`id=${leaseId}`)) return leasePresent ? leaseId : "";
    if(args[0] === "rm" && args.at(-1) === leaseId) { leasePresent=false; return ""; }
    if(args[0] === "volume") return owner;
    if(args[0] === "create") {
      assert.ok(runtime.journalSnapshot()?.pending.some(intent => intent.action === "namespace_create"),"fixture_intent_before_namespace_create");
      if(failCreate) { if(late) namespaceId=(nextId++).toString(16).padStart(64,"0"); throw new DockerCommandError("cancelled"); }
      namespaceId=(nextId++).toString(16).padStart(64,"0"); return namespaceId;
    }
    if(args[0] === "inspect") {
      assert.ok(namespaceId,"fixture_namespace_missing");
      return JSON.stringify({id:namespaceId,owner,operation:runtime.operationIdentity().operation,running:true,status:"running"});
    }
    if(args.includes(`name=^/${runtime.container}$`)) return namespaceId ? runtime.container : "";
    if(args.some(value => value.startsWith("id="))) return args.includes(`id=${namespaceId}`) ? namespaceId! : "";
    if(args[0] === "rm") { namespaceId=undefined; return ""; }
    if(args[0] === "exec") {
      const script=args[4];
      for(const [name,hash] of hashes) if(script.includes(`/opt/cg/${name}`)) return hash;
      if(script.includes("/opt/cg/claude'")) return pins.claude.sha256;
      return "true";
    }
    return "";
  };
  return {runtime,commands,leaseId,leasePresent:()=>leasePresent,namespaceId:()=>namespaceId,loseCreate:(createLater=false)=>{failCreate=true;late=createLater;},revealLate:()=>{namespaceId=(nextId++).toString(16).padStart(64,"0");},removeNamespaceExternally:()=>{namespaceId=undefined;},removeExternally:()=>{namespaceId=undefined;leasePresent=false;}};
}
async function fixture(run:(value:Fixture,directory:string)=>Promise<void>, factory?: ManagedJournalOptions["journalFactory"]) {
  const directory=await mkdtemp(path.join(fixtureTempRoot,"cg-runtime-journal-fixture-"));
  try { await run(await makeFixture(directory,factory),directory); }
  finally { assert.equal(path.dirname(directory),fixtureTempRoot); assert.ok(path.basename(directory).startsWith("cg-runtime-journal-fixture-")); await rm(directory,{recursive:true,force:true}); }
}
const mutations=(commands:string[][]) => commands.filter(args => ["create","start","exec","rm"].includes(args[0]) || args[0] === "volume" && ["create","rm"].includes(args[1]));
function failingFactory(fail:(event:"intent"|"capture"|"receipt",value:any)=>boolean):ManagedJournalOptions["journalFactory"] {
  return async(identity,options) => {
    const journal=await createOperationJournal(identity,options);
    return {...journal,
      appendIntent:async value=>{if(fail("intent",value))throw Error("SYNTHETIC_SECRET_WRITER_FAILURE");await journal.appendIntent(value);},
      appendCapture:async value=>{if(fail("capture",value))throw Error("SYNTHETIC_SECRET_WRITER_FAILURE");await journal.appendCapture(value);},
      appendReceipt:async value=>{if(fail("receipt",value))throw Error("SYNTHETIC_SECRET_WRITER_FAILURE");await journal.appendReceipt(value);},
    } satisfies OperationJournal;
  };
}

test("durable receipts precede mutations, survive stop/restart and release the lease last",async()=>fixture(async({runtime,commands,leaseId},directory)=>{
  await runtime.start();
  const first=runtime.journalSnapshot()!;
  assert.equal(first.lease_id,leaseId);assert.equal(first.pending.length,0);assert.equal(first.namespace_ids.length,1);
  const containerId=await runtime.verifyOperation();
  await runtime.beginNamespaceExec(containerId);
  assert.ok(runtime.journalSnapshot()!.pending.some(intent=>intent.action === "namespace_exec"));
  await runtime.stop();
  assert.equal(runtime.journalSnapshot()!.pending.length,0);assert.equal(runtime.journalSnapshot()!.terminal,false);assert.equal(runtime.leaseIdentity()!.lease_id,leaseId);
  await runtime.start();assert.deepEqual(runtime.journalSnapshot()!.identity,first.identity);
  await runtime.finishOperation();
  assert.equal(runtime.journalSnapshot()!.terminal,true);
  assert.deepEqual(mutations(commands).at(-1),["rm",leaseId]);
  const restored=ManagedCliRuntime.restore(runtime.identity(),{journalRoot:directory});
  assert.notEqual(restored.operationIdentity().operation,first.identity.operation);assert.equal(restored.leaseIdentity(),undefined);assert.equal(restored.journalSnapshot(),undefined);
  const persisted=await readOperationJournals(directory);assert.equal(persisted.status,"available");assert.equal(persisted.operations[0].terminal,true);
  const texts:string[]=[];
  for(const subdir of await readdir(directory))for(const name of await readdir(path.join(directory,subdir)))texts.push(await readFile(path.join(directory,subdir,name),"utf8"));
  const token=commands.flat().find(value=>value.startsWith("CG_TOOL_TOKEN="))!;
  assert.ok(token);assert.ok(!texts.join("").includes(token.split("=")[1]));
  assert.ok(!texts.join("").includes("HTTPS_PROXY"));assert.ok(!texts.join("").includes("setTimeout"));
}));

test("an intent publication failure blocks create, cleanup and lease release",async()=>fixture(async({runtime,commands,leasePresent})=>{
  await assert.rejects(()=>runtime.beginOperation(),/managed_operation_journal_failed/);
  await assert.rejects(()=>runtime.finishOperation(),/managed_operation_journal_failed/);
  assert.equal(mutations(commands).length,0);assert.equal(leasePresent(),false);
},failingFactory(event=>event === "intent")));

test("a capture publication failure after Docker create retains ownership and forbids release",async()=>fixture(async({runtime,commands,leasePresent})=>{
  await assert.rejects(()=>runtime.beginOperation(),/managed_operation_journal_failed/);
  assert.equal(leasePresent(),true);assert.equal(mutations(commands).length,1);
  await assert.rejects(()=>runtime.destroy(),/managed_operation_journal_failed/);
  await assert.rejects(()=>runtime.finishOperation(),/managed_operation_journal_failed/);
  assert.equal(mutations(commands).length,1);assert.equal(runtime.journalSnapshot()!.terminal,false);
},failingFactory(event=>event === "capture")));

test("a lost create ID remains pending through absent snapshots and settles only with exact owned evidence",async()=>fixture(async({runtime,commands,loseCreate,revealLate,leasePresent})=>{
  await runtime.beginOperation();loseCreate();
  await assert.rejects(()=>runtime.start(),/managed_start_cleanup_unconfirmed/);
  const pending=runtime.journalSnapshot()!.pending.filter(intent=>intent.action === "namespace_create");assert.equal(pending.length,1);
  assert.equal(runtime.journalSnapshot()!.captures.filter(value=>value.intent_id === pending[0].intent_id).length,0);
  await assert.rejects(()=>runtime.finishOperation(),/managed_cleanup_unconfirmed/);
  assert.equal(leasePresent(),true);assert.ok(!commands.some(args=>args[0] === "rm"));
  revealLate();await runtime.stop();await runtime.finishOperation();
  assert.equal(runtime.journalSnapshot()!.pending.length,0);assert.equal(runtime.journalSnapshot()!.terminal,true);
}));

test("a verified removal receipt failure prevents final release even after namespace absence",async()=>{
  let journal:OperationJournal|undefined;
  const factory:ManagedJournalOptions["journalFactory"]=async(identity,options)=>{
    journal=await createOperationJournal(identity,options);
    return {...journal,appendReceipt:async(receipt:JournalReceipt)=>{
      if(journal!.snapshot().pending.find(intent=>intent.intent_id === receipt.intent_id)?.action === "namespace_remove")throw Error("SYNTHETIC_SECRET_WRITER_FAILURE");
      await journal!.appendReceipt(receipt);
    }};
  };
  await fixture(async({runtime,commands,leasePresent,namespaceId})=>{
    await runtime.start();await assert.rejects(()=>runtime.stop(),/managed_operation_journal_failed/);
    assert.equal(namespaceId(),undefined);assert.equal(leasePresent(),true);
    const before=mutations(commands).length;await assert.rejects(()=>runtime.finishOperation(),/managed_operation_journal_failed/);
    assert.equal(mutations(commands).length,before);assert.equal(runtime.journalSnapshot()!.terminal,false);
  },factory);
});

test("a pre-aborted operation neither opens a journal nor contacts Docker",async()=>fixture(async({runtime,commands},directory)=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>runtime.start({signal:controller.signal}),/docker_cancelled/);
  assert.equal(runtime.journalSnapshot(),undefined);assert.equal(commands.length,0);assert.deepEqual(await readdir(directory),[]);
}));

test("an old owner can record confirmed external cleanup without a fresh claim or deletion",async()=>fixture(async({runtime,commands,removeExternally})=>{
  await runtime.start();const containerId=await runtime.verifyOperation();await runtime.beginNamespaceExec(containerId);
  removeExternally();const before=mutations(commands).length;
  await runtime.finishOperation();
  assert.equal(mutations(commands).length,before);assert.equal(runtime.journalSnapshot()!.terminal,true);assert.equal(runtime.journalSnapshot()!.pending.length,0);
  assert.equal(runtime.leaseIdentity(),undefined);
}));

test("captured exec cleanup settles confirmed external namespace absence before dropping the ID",async()=>fixture(async({runtime,commands,removeNamespaceExternally,leasePresent})=>{
  await runtime.start();const containerId=await runtime.verifyOperation();await runtime.beginNamespaceExec(containerId);
  removeNamespaceExternally();const before=mutations(commands).length;
  await (runtime as any).stopOperationContainer(containerId);
  assert.equal(mutations(commands).length,before);assert.equal(runtime.journalSnapshot()!.pending.length,0);
  assert.equal(leasePresent(),true);
  await runtime.finishOperation();assert.equal(runtime.journalSnapshot()!.terminal,true);assert.equal(leasePresent(),false);
}));

async function recoveryFixture(run:(value:Awaited<ReturnType<typeof makeRecoveryFixture>>,directory:string)=>Promise<void>) {
  const directory=await mkdtemp(path.join(fixtureTempRoot,"cg-recovery-journal-fixture-"));
  try { await run(await makeRecoveryFixture(directory),directory); }
  finally { assert.equal(path.dirname(directory),fixtureTempRoot);assert.ok(path.basename(directory).startsWith("cg-recovery-journal-fixture-"));await rm(directory,{recursive:true,force:true}); }
}
async function makeRecoveryFixture(directory:string) {
  const owner=randomUUID(),operation=randomUUID(),leaseId="c".repeat(64),namespaceId="a".repeat(64),commands:string[][]=[];
  const runtime=ManagedCliRuntime.restore({owner,provider:"claude"},{journalRoot:directory});
  const receipt={operation,lease_id:leaseId,owner_quiesced:true} as const;
  const namespaces=new Map<string,ManagedContainerEvidence>([[namespaceId,{id:namespaceId,owner,operation,running:false,status:"exited"}]]);
  const names=new Map([[runtime.container,namespaceId]]),leaseName=`cg-managed-lease-${owner}`;
  let leasePresent=true;
  (runtime as any).command=async(args:string[])=>{
    commands.push(args);
    if(args[0] === "inspect" && [leaseName,leaseId].includes(args.at(-1)!)) {
      assert.ok(leasePresent,"fixture_lease_absent");
      return JSON.stringify({id:leaseId,name:`/${leaseName}`,owner,provider:"claude",operation,kind:"managed-profile-claim",schema:"1",running:false,status:"created",network:"none",readonly:true,mounts:0,ports:0});
    }
    if(args.includes(`name=^/${leaseName}$`))return leasePresent ? leaseName : "";
    if(args.includes(`id=${leaseId}`))return leasePresent ? leaseId : "";
    if(args.some(value=>value.startsWith("label=")))return [leasePresent ? leaseId : "",...[...namespaces.values()].filter(value=>value.owner === owner && value.operation === operation).map(value=>value.id)].filter(Boolean).join("\n");
    if(args[0] === "inspect") {
      const target=args.at(-1)!,value=namespaces.get(names.get(target) ?? target);
      assert.ok(value,"fixture_namespace_absent");return JSON.stringify(value);
    }
    if(args[0] === "container" && args[1] === "ls") {
      const name=[...names.keys()].find(value=>args.includes(`name=^/${value}$`));
      if(name)return namespaces.has(names.get(name)!) ? name : "";
      const target=args.find(value=>value.startsWith("id="))?.slice(3);
      if(target)return namespaces.has(target) ? target : "";
      return "";
    }
    if(args[0] === "rm") {
      assert.equal(args.length,2,"fixture_recovery_nonforced");
      if(args[1] === leaseId)leasePresent=false;else namespaces.delete(args[1]);return "";
    }
    throw Error("unexpected_recovery_dispatch");
  };
  const recordOldJournal=async(changes:{identity?:Partial<{owner:string;provider:string;operation:string}>;lease_id?:string;namespace_ids?:string[];pending_create?:boolean;terminal?:boolean}={})=>{
    const journal=await createOperationJournal({owner,provider:"claude",operation,...changes.identity},{root:directory});
    const recordedLease=changes.lease_id ?? leaseId,leaseIntent=randomUUID();
    await journal.appendIntent({intent_id:leaseIntent,action:"lease_acquire"});await journal.appendCapture({intent_id:leaseIntent,resource_id:recordedLease});await journal.appendReceipt({intent_id:leaseIntent,outcome:"verified",lease_id:recordedLease});
    for(const resource_id of changes.namespace_ids ?? [namespaceId]) {
      const intent_id=randomUUID();await journal.appendIntent({intent_id,action:"namespace_create",role:"runtime"});await journal.appendCapture({intent_id,resource_id});await journal.appendReceipt({intent_id,outcome:"verified",resource_id});
    }
    if(changes.pending_create)await journal.appendIntent({intent_id:randomUUID(),action:"namespace_create",role:"init"});
    if(changes.terminal) {
      for(const resource_id of journal.snapshot().namespace_ids) { const intent_id=randomUUID();await journal.appendIntent({intent_id,action:"namespace_remove",role:"runtime",resource_id});await journal.appendReceipt({intent_id,outcome:"verified",resource_id}); }
      const intent_id=randomUUID();await journal.appendIntent({intent_id,action:"lease_release"});await journal.appendReceipt({intent_id,outcome:"verified",lease_id:recordedLease});await journal.complete();
    }
    return journal;
  };
  return {runtime,receipt,owner,operation,leaseId,namespaceId,namespaces,names,commands,recordOldJournal,leasePresent:()=>leasePresent};
}

test("owner quiescence cannot override an old uncaptured create while a known stopped namespace remains",async()=>recoveryFixture(async({runtime,receipt,recordOldJournal,commands,namespaces})=>{
  const journal=await recordOldJournal({pending_create:true});
  assert.equal(journal.snapshot().pending.length,1);assert.equal(journal.snapshot().captures.length,2);
  await assert.rejects(()=>runtime.recoverStopped(receipt),/managed_recovery_journal_pending/);
  assert.equal(commands.length,0);assert.equal(namespaces.size,1);
}));

test("missing, mismatched, corrupt and terminal old journals reject before any destructive dispatch",async()=>{
  for(const shape of ["missing","owner","provider","operation","lease","corrupt","terminal"] as const)await recoveryFixture(async({runtime,receipt,recordOldJournal,commands},directory)=>{
    if(shape !== "missing") {
      const journal=await recordOldJournal(shape === "owner" ? {identity:{owner:randomUUID()}} : shape === "provider" ? {identity:{provider:"codex"}} : shape === "operation" ? {identity:{operation:randomUUID()}} : shape === "lease" ? {lease_id:"d".repeat(64)} : shape === "terminal" ? {terminal:true} : {});
      if(shape === "corrupt") { const identity=journal.identity;await writeFile(path.join(directory,`op-${identity.owner}-${identity.operation}`,"000001.json"),"{}"); }
    }
    await assert.rejects(()=>runtime.recoverStopped(receipt),/managed_recovery_journal_/);
    assert.equal(commands.length,0);
  });
});

test("recovery refuses every present unrecorded namespace before any removal",async()=>{
  for(const named of [false,true])await recoveryFixture(async({runtime,receipt,recordOldJournal,namespaces,names,owner,operation,commands})=>{
    await recordOldJournal();const extraId="b".repeat(64);namespaces.set(extraId,{id:extraId,owner,operation,running:false,status:"exited"});
    if(named)names.set(`cg-managed-init-${owner}`,extraId);
    await assert.rejects(()=>runtime.recoverStopped(receipt),/managed_recovery_namespace_unrecorded/);
    assert.equal(mutations(commands).length,0);
  });
});

test("all captured still-present IDs prevalidate before recovery deletes the first namespace",async()=>{
  for(const shape of ["running","foreign_operation","foreign_owner"] as const)await recoveryFixture(async({runtime,receipt,recordOldJournal,namespaces,namespaceId,owner,operation,commands})=>{
    const renamedId="b".repeat(64);await recordOldJournal({namespace_ids:[namespaceId,renamedId]});
    namespaces.set(renamedId,{id:renamedId,owner:shape === "foreign_owner" ? randomUUID() : owner,operation:shape === "foreign_operation" ? randomUUID() : operation,running:shape === "running",status:shape === "running" ? "running" : "exited"});
    await assert.rejects(()=>runtime.recoverStopped(receipt),shape === "running" ? /managed_recovery_requires_stopped/ : shape === "foreign_owner" ? /managed_owner_mismatch/ : /managed_operation_mismatch/);
    assert.equal(mutations(commands).length,0);assert.equal(namespaces.size,2);
  });
});

test("clean recorded stopped namespaces recover by exact ID, retain volumes and release the lease last",async()=>recoveryFixture(async({runtime,receipt,recordOldJournal,namespaces,namespaceId,owner,operation,commands,leaseId,leasePresent},directory)=>{
  const renamedId="b".repeat(64);const journal=await recordOldJournal({namespace_ids:[namespaceId,renamedId,"e".repeat(64)]});
  namespaces.set(renamedId,{id:renamedId,owner,operation,running:false,status:"dead"});
  const before=journal.snapshot();assert.equal(before.pending.length,0);
  assert.deepEqual(await runtime.recoverStopped(receipt),{recovered_containers:2,private_volumes_retained:true});
  assert.deepEqual(mutations(commands),[["rm",namespaceId],["rm",renamedId],["rm",leaseId]]);assert.equal(leasePresent(),false);
  assert.ok(!commands.some(args=>args[0] === "volume" || args.includes("--force")));
  const persisted=await readOperationJournals(directory);assert.equal(persisted.status,"available");assert.deepEqual(persisted.operations[0],before);assert.equal(persisted.operations[0].terminal,false);
}));

test("a current runtime journal I/O failure also blocks legacy recovery",async()=>fixture(async({runtime,commands},directory)=>{
  await assert.rejects(()=>runtime.beginOperation(),/managed_operation_journal_failed/);
  const oldOperation=randomUUID(),journal=await createOperationJournal({owner:runtime.owner,provider:runtime.provider,operation:oldOperation},{root:directory});
  const intent_id=randomUUID();await journal.appendIntent({intent_id,action:"lease_acquire"});await journal.appendReceipt({intent_id,outcome:"verified",lease_id:"d".repeat(64)});
  const before=commands.length;await assert.rejects(()=>runtime.recoverStopped({operation:oldOperation,lease_id:"d".repeat(64),owner_quiesced:true}),/managed_operation_journal_failed/);
  assert.equal(commands.length,before);
},failingFactory(event=>event === "intent")));
