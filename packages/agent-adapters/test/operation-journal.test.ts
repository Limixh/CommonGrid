import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOperationJournal, readOperationJournals, type JournalPublicationStage, type OperationIdentity } from "../src/operation-journal.ts";

const resource="a".repeat(64), lease="b".repeat(64);
function who():OperationIdentity { return {owner:randomUUID(),provider:"codex",operation:randomUUID()}; }
async function fixture(t: TestContext) {
  const tempParent=await realpath(os.tmpdir());
  const temporary=await mkdtemp(path.join(tempParent,"commongrid-journal-"));
  // Cleanup only the exact directory returned by mkdtemp under the intended temp root.
  assert.equal(path.dirname(temporary),tempParent);
  t.after(() => rm(temporary,{recursive:true,force:true}));
  return {temporary,root:path.join(temporary,"journal")};
}
async function acquire(journal: Awaited<ReturnType<typeof createOperationJournal>>) {
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"lease_acquire"});
  await journal.appendCapture({intent_id,resource_id:lease});
  await journal.appendReceipt({intent_id,outcome:"verified",lease_id:lease});
}
async function release(journal: Awaited<ReturnType<typeof createOperationJournal>>) {
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"lease_release"});
  await journal.appendReceipt({intent_id,outcome:"verified",lease_id:lease});
}
function operationDirectory(root: string, identity: OperationIdentity) { return path.join(root,`op-${identity.owner}-${identity.operation}`); }

test("real disk journal survives read-only reopen with immutable captures and a terminal lease receipt",async t => {
  const f=await fixture(t), identity=who(), journal=await createOperationJournal(identity,{root:f.root});
  await acquire(journal);
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"namespace_create",role:"runtime"});
  await journal.appendCapture({intent_id,resource_id:resource});
  assert.equal(journal.snapshot().pending.length,1);
  assert.deepEqual(journal.snapshot().namespace_ids,[resource]);
  await journal.appendReceipt({intent_id,outcome:"verified",resource_id:resource});
  const remove=randomUUID(); await journal.appendIntent({intent_id:remove,action:"namespace_remove",role:"runtime",resource_id:resource});
  await journal.appendReceipt({intent_id:remove,outcome:"verified",resource_id:resource});
  await release(journal); await journal.complete();
  assert.equal(journal.snapshot().terminal,true);
  assert.equal(journal.snapshot().durability,process.platform === "win32" ? "process_crash" : "file_and_directory_synced");
  const result=await readOperationJournals(f.root); assert.equal(result.status,"available");
  assert.deepEqual(result.operations,[journal.snapshot()]);
  await assert.rejects(createOperationJournal(identity,{root:f.root}),/^Error: operation_journal_exists$/);
});

test("namespace-free begin and finish is complete only after verified lease release",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal); await release(journal); await journal.complete();
  assert.equal((await readOperationJournals(f.root)).operations[0].terminal,true);
  const second=await createOperationJournal(who(),{root:f.root}); await acquire(second);
  await assert.rejects(second.complete(),/^Error: operation_journal_invalid$/);
  await assert.rejects(second.appendIntent({intent_id:randomUUID(),action:"lease_release"}),/^Error: operation_journal_writer_failed$/);
});

test("pending intents survive crashes without absence or age resolving them",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const pending={intent_id:randomUUID(),action:"namespace_create" as const,role:"init" as const}; await journal.appendIntent(pending);
  const result=await readOperationJournals(f.root); assert.equal(result.status,"available");
  assert.deepEqual(result.operations[0].pending,[pending]); assert.equal(result.operations[0].terminal,false);
  await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"lease_release"}),/^Error: operation_journal_invalid$/);
});

test("failed publication prevents dispatch and poisons writer at every boundary",async t => {
  for(const stage of ["before_write","after_file_sync","after_publish","after_directory_sync"] as JournalPublicationStage[]) {
    const f=await fixture(t); let armed=false, dispatched=0;
    const journal=await createOperationJournal(who(),{root:f.root,publicationFault:current => { if(armed && current === stage) throw Error("SYNTHETIC_SECRET_FAILURE"); }});
    armed=true;
    await assert.rejects(async () => { await journal.appendIntent({intent_id:randomUUID(),action:"lease_acquire"}); dispatched++; },/^Error: operation_journal_publish_failed$/);
    assert.equal(dispatched,0); assert.equal(journal.snapshot().last_sequence,1);
    await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"lease_acquire"}),/^Error: operation_journal_writer_failed$/);
    const read=await readOperationJournals(f.root);
    assert.equal(read.status,stage === "after_publish" ? "blocked" : "available");
    if(stage === "after_directory_sync") assert.equal(read.operations[0].pending.length,1,"a completed publication can outlive a failed caller; it remains a pending intent");
  }
});

test("concurrent append calls serialize while exclusive publication never overwrites a collision",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const first=randomUUID(), second=randomUUID();
  await Promise.all([journal.appendIntent({intent_id:first,action:"public_install",role:"tools"}),journal.appendIntent({intent_id:second,action:"public_manifest_publish"})]);
  assert.deepEqual(journal.snapshot().pending.map(value => value.intent_id),[first,second]);
  const other=who(), directory=operationDirectory(f.root,other); let armed=false;
  const collided=await createOperationJournal(other,{root:f.root,publicationFault:async stage => { if(armed && stage === "after_file_sync") await writeFile(path.join(directory,"000002.json"),"INCUMBENT_BYTES",{flag:"wx"}); }});
  armed=true;
  await assert.rejects(collided.appendIntent({intent_id:randomUUID(),action:"lease_acquire"}),/^Error: operation_journal_publish_failed$/);
  assert.equal(await readFile(path.join(directory,"000002.json"),"utf8"),"INCUMBENT_BYTES");
  assert.equal((await readOperationJournals(f.root)).status,"blocked");
});

test("parallel creators arbitrate by operation directory without adopting or overwriting history",async t => {
  const f=await fixture(t), identity=who(); const results=await Promise.allSettled([createOperationJournal(identity,{root:f.root}),createOperationJournal(identity,{root:f.root})]);
  assert.equal(results.filter(result => result.status === "fulfilled").length,1);
  assert.equal((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message,"operation_journal_exists");
  assert.equal((await readOperationJournals(f.root)).operations.length,1);
});

test("capture is immutable, never clears pending, and a receipt must match it",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"namespace_create",role:"runtime"}); await journal.appendCapture({intent_id,resource_id:resource});
  await assert.rejects(journal.appendReceipt({intent_id,outcome:"verified",resource_id:"c".repeat(64)}),/^Error: operation_journal_invalid$/);
  const result=await readOperationJournals(f.root); assert.equal(result.operations[0].pending.length,1); assert.deepEqual(result.operations[0].namespace_ids,[resource]);
});

test("historical namespace IDs remain after cleanup but an active namespace prevents lease release",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"namespace_create",role:"runtime"}); await journal.appendReceipt({intent_id,outcome:"verified",resource_id:resource});
  await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"lease_release"}),/^Error: operation_journal_invalid$/);
  const read=await readOperationJournals(f.root); assert.equal(read.operations[0].terminal,false); assert.deepEqual(read.operations[0].namespace_ids,[resource]);
});

test("namespace actions require a captured immutable ID with the original role",async t => {
  for(const mismatch of ["unknown_id","wrong_role"] as const) {
    const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
    const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"namespace_create",role:"init"}); await journal.appendCapture({intent_id,resource_id:resource});
    await journal.appendReceipt({intent_id,outcome:"verified",resource_id:resource});
    await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"namespace_exec",role:mismatch === "wrong_role" ? "runtime" : "init",resource_id:mismatch === "unknown_id" ? "c".repeat(64) : resource}),/^Error: operation_journal_invalid$/);
  }
});

test("action metadata is restricted and checkpoint publication is an explicit pending phase",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"public_checkpoint_publish"});
  assert.equal((await readOperationJournals(f.root)).operations[0].pending[0].action,"public_checkpoint_publish");
  await journal.appendReceipt({intent_id,outcome:"verified"});
  await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"public_checkpoint_publish",role:"auth"}),/^Error: operation_journal_invalid$/);
});

test("a pending lease release seals further mutation intents before its receipt",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const intent_id=randomUUID(); await journal.appendIntent({intent_id,action:"lease_release"});
  await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"public_checkpoint_publish"}),/^Error: operation_journal_invalid$/);
  const read=await readOperationJournals(f.root); assert.deepEqual(read.operations[0].pending,[{intent_id,action:"lease_release"}]);
  assert.equal(read.operations[0].terminal,false);
});

test("a pending acquire excludes another claim while a pre-dispatch rejection permits a fresh intent",async t => {
  const f=await fixture(t), rejected=await createOperationJournal(who(),{root:f.root}), intent_id=randomUUID();
  await rejected.appendIntent({intent_id,action:"lease_acquire"}); await rejected.appendReceipt({intent_id,outcome:"rejected_before_dispatch"});
  await acquire(rejected); assert.equal(rejected.snapshot().lease_id,lease);
  const unresolved=await createOperationJournal(who(),{root:f.root}); await unresolved.appendIntent({intent_id:randomUUID(),action:"lease_acquire"});
  await assert.rejects(unresolved.appendIntent({intent_id:randomUUID(),action:"lease_acquire"}),/^Error: operation_journal_invalid$/);
  assert.equal(unresolved.snapshot().pending.length,1);
});

test("rejected-before-dispatch cannot erase a captured dispatch",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}), intent_id=randomUUID();
  await journal.appendIntent({intent_id,action:"lease_acquire"}); await journal.appendCapture({intent_id,resource_id:lease});
  await assert.rejects(journal.appendReceipt({intent_id,outcome:"rejected_before_dispatch"}),/^Error: operation_journal_invalid$/);
  assert.equal((await readOperationJournals(f.root)).operations[0].pending.length,1);
});

test("unknown fields and synthetic private errors are rejected without storing their values",async t => {
  const f=await fixture(t), identity=who(), secret="SYNTHETIC_PRIVATE_ARGV_AND_AUTH";
  await assert.rejects(createOperationJournal({...identity,auth:secret} as OperationIdentity,{root:f.root}),/^Error: operation_journal_invalid$/);
  const journal=await createOperationJournal(identity,{root:f.root});
  await assert.rejects(journal.appendIntent({intent_id:randomUUID(),action:"lease_acquire",argv:[secret]} as any),/^Error: operation_journal_invalid$/);
  const directory=operationDirectory(f.root,identity); for(const file of await readdir(directory)) assert.equal((await readFile(path.join(directory,file),"utf8")).includes(secret),false);
});

test("snapshots are detached copies and contain no path, PID, timestamp or execution authorization",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root}); await acquire(journal);
  const view=journal.snapshot(); (view.identity as OperationIdentity).owner=randomUUID(); (view.captures as any[])[0].resource_id="c".repeat(64);
  assert.notDeepEqual(view,journal.snapshot());
  for(const forbidden of ["root","path","pid","age","timestamp","owner_quiesced","execution_enabled"]) assert.equal(Object.hasOwn(journal.snapshot(),forbidden),false);
});

test("submitted metadata is detached before queued disk writes",async t => {
  const f=await fixture(t), journal=await createOperationJournal(who(),{root:f.root});
  const intent={intent_id:randomUUID(),action:"lease_acquire" as const}, original={...intent}; const write=journal.appendIntent(intent);
  intent.intent_id=randomUUID(); await write;
  assert.deepEqual((await readOperationJournals(f.root)).operations[0].pending,[original]);
});

test("invalid, truncated, oversized, gapped and unexpected entries block the entire catalog",async t => {
  for(const damage of ["json","hash","size","gap","extra"] as const) {
    const f=await fixture(t), identity=who(); await createOperationJournal(identity,{root:f.root}); const directory=operationDirectory(f.root,identity), filename=path.join(directory,"000001.json");
    if(damage === "json") await writeFile(filename,"{\"private\":\"SYNTHETIC_SECRET");
    if(damage === "hash") { const content=await readFile(filename,"utf8"); await writeFile(filename,content.replace('"schema":1','"schema":2')); }
    if(damage === "size") await writeFile(filename,"x".repeat(8193));
    if(damage === "gap") await rename(filename,path.join(directory,"000002.json"));
    if(damage === "extra") await writeFile(path.join(directory,".pending-orphan"),"SYNTHETIC_SECRET");
    assert.deepEqual(await readOperationJournals(f.root),{status:"blocked",reason:"operation_journal_invalid",operations:[]});
  }
});

test("missing root, bounded catalog, and root/record symlinks fail conservatively",async t => {
  const f=await fixture(t); assert.deepEqual(await readOperationJournals(f.root),{status:"unavailable",reason:"operation_journal_missing",operations:[]});
  await createOperationJournal(who(),{root:f.root}); await createOperationJournal(who(),{root:f.root});
  assert.deepEqual(await readOperationJournals(f.root,{maxOperations:1}),{status:"blocked",reason:"operation_journal_overflow",operations:[]});
  const linked=path.join(f.temporary,"linked");
  await symlink(f.root,linked,process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await readOperationJournals(linked),{status:"blocked",reason:"operation_journal_invalid",operations:[]});
  const operation=(await readdir(f.root))[0], record=path.join(f.root,operation,"000001.json"), target=path.join(f.temporary,"record"); await rename(record,target);
  try { await symlink(target,record,"file"); } catch(error) { if(process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Windows file symlink permission unavailable; junction rejection was exercised"); return; } throw error; }
  assert.deepEqual(await readOperationJournals(f.root),{status:"blocked",reason:"operation_journal_invalid",operations:[]});
});
