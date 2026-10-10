import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, link, unlink } from "node:fs/promises";
import path from "node:path";
import type { JournalCapture, JournalDurability, JournalIntent, JournalReceipt, OperationIdentity, OperationJournal, OperationJournalReadResult, OperationJournalSnapshot } from "./operation-journal-types.ts";
export type * from "./operation-journal-types.ts";

export const operationJournalLimits = Object.freeze({ maxOperations: 4096, defaultOperations: 1024, maxRecords: 512, maxRecordBytes: 8192 });
export type JournalPublicationStage = "before_write" | "after_file_sync" | "after_publish" | "after_directory_sync";
export interface OperationJournalOptions { root: string; publicationFault?: (stage: JournalPublicationStage) => void | Promise<void> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = /^[a-f0-9]{64}$/;
const directoryPattern = /^op-([0-9a-f-]{36})-([0-9a-f-]{36})$/;
const zeroHash = "0".repeat(64);
const actions = new Set(["lease_acquire","lease_release","namespace_create","namespace_start","namespace_remove","namespace_exec","volume_create","volume_remove","public_install","public_manifest_publish","public_checkpoint_publish"]);
const roles = new Set(["runtime","init","tools","auth"]);
type Event = { kind: "begin" } | { kind: "intent"; intent: JournalIntent } | { kind: "receipt"; receipt: JournalReceipt } | { kind: "capture"; capture: JournalCapture } | { kind: "complete" };
interface RecordBody { schema: 1; sequence: number; previous_hash: string; identity: OperationIdentity; durability: JournalDurability; event: Event }
interface State { identity: OperationIdentity; durability: JournalDurability; sequence: number; hash: string; terminal: boolean; lease?: string; released: boolean; intents: Map<string,JournalIntent>; pending: Map<string,JournalIntent>; captures: Map<string,JournalCapture>; namespaces: Set<string>; activeNamespaces: Map<string,JournalIntent["role"]> }
class JournalError extends Error { constructor(readonly code: string) { super(code); } }
function ensure(value: unknown, code = "operation_journal_invalid"): asserts value { if (!value) throw new JournalError(code); }
function object(value: unknown): asserts value is Record<string,unknown> { ensure(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value))); }
function keys(value: Record<string,unknown>, required: string[], optional: string[] = []) { ensure(required.every(key => Object.hasOwn(value,key)) && Reflect.ownKeys(value).every(key => typeof key === "string" && (required.includes(key) || optional.includes(key)))); }
function identity(value: unknown): OperationIdentity {
  object(value); keys(value,["owner","provider","operation"]);
  ensure(typeof value.owner === "string" && uuid.test(value.owner) && typeof value.operation === "string" && uuid.test(value.operation) && typeof value.provider === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value.provider));
  return {owner:value.owner,provider:value.provider,operation:value.operation};
}
function intent(value: unknown): JournalIntent {
  object(value); keys(value,["intent_id","action"],["role","resource_id"]);
  ensure(typeof value.intent_id === "string" && uuid.test(value.intent_id) && typeof value.action === "string" && actions.has(value.action));
  if (Object.hasOwn(value,"role")) ensure(typeof value.role === "string" && roles.has(value.role));
  if (Object.hasOwn(value,"resource_id")) ensure(typeof value.resource_id === "string" && id.test(value.resource_id));
  if (value.action.startsWith("lease_")) ensure(value.role === undefined && value.resource_id === undefined);
  if (value.action.startsWith("namespace_")) {
    ensure(value.role === "runtime" || value.role === "init");
    ensure(value.action === "namespace_create" ? value.resource_id === undefined : typeof value.resource_id === "string");
  }
  if (value.action.startsWith("volume_")) ensure((value.role === "tools" || value.role === "auth") && value.resource_id === undefined);
  if (value.action === "public_install") ensure(value.role === "tools" && value.resource_id === undefined);
  if (value.action === "public_manifest_publish" || value.action === "public_checkpoint_publish") ensure(value.role === undefined && value.resource_id === undefined);
  return {intent_id:value.intent_id,action:value.action as JournalIntent["action"],...(value.role === undefined ? {} : {role:value.role as JournalIntent["role"]}),...(value.resource_id === undefined ? {} : {resource_id:value.resource_id as string})};
}
function receipt(value: unknown): JournalReceipt {
  object(value); keys(value,["intent_id","outcome"],["lease_id","resource_id"]);
  ensure(typeof value.intent_id === "string" && uuid.test(value.intent_id) && ["verified","rejected_before_dispatch"].includes(String(value.outcome)));
  for (const key of ["lease_id","resource_id"] as const) if (Object.hasOwn(value,key)) ensure(typeof value[key] === "string" && id.test(value[key]));
  ensure(value.outcome !== "rejected_before_dispatch" || (value.lease_id === undefined && value.resource_id === undefined));
  return {intent_id:value.intent_id,outcome:value.outcome as JournalReceipt["outcome"],...(value.lease_id === undefined ? {} : {lease_id:value.lease_id as string}),...(value.resource_id === undefined ? {} : {resource_id:value.resource_id as string})};
}
function capture(value: unknown): JournalCapture {
  object(value); keys(value,["intent_id","resource_id"]); ensure(typeof value.intent_id === "string" && uuid.test(value.intent_id) && typeof value.resource_id === "string" && id.test(value.resource_id));
  return {intent_id:value.intent_id,resource_id:value.resource_id};
}
function event(value: unknown): Event {
  object(value);
  if(value.kind === "begin" || value.kind === "complete") { keys(value,["kind"]); return {kind:value.kind}; }
  if(value.kind === "intent") { keys(value,["kind","intent"]); return {kind:"intent",intent:intent(value.intent)}; }
  if(value.kind === "receipt") { keys(value,["kind","receipt"]); return {kind:"receipt",receipt:receipt(value.receipt)}; }
  if(value.kind === "capture") { keys(value,["kind","capture"]); return {kind:"capture",capture:capture(value.capture)}; }
  throw new JournalError("operation_journal_invalid");
}
const digest = (body: RecordBody) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
function initial(who: OperationIdentity, durability: JournalDurability): State { return {identity:who,durability,sequence:0,hash:zeroHash,terminal:false,released:false,intents:new Map(),pending:new Map(),captures:new Map(),namespaces:new Set(),activeNamespaces:new Map()}; }
function apply(state: State, value: Event) {
  ensure(!state.terminal);
  if(value.kind === "begin") { ensure(state.sequence === 0); return; }
  ensure(state.sequence > 0);
  if(value.kind === "complete") { ensure(state.pending.size === 0 && state.lease && state.released); state.terminal=true; return; }
  if(value.kind === "intent") {
    const target=value.intent; ensure(!state.intents.has(target.intent_id));
    ensure(![...state.pending.values()].some(intent => intent.action === "lease_release"));
    if(target.action === "lease_acquire") ensure(!state.lease && !state.released && state.pending.size === 0);
    else ensure(state.lease && !state.released);
    if(target.action === "lease_release") ensure(state.pending.size === 0 && state.activeNamespaces.size === 0);
    if(target.action.startsWith("namespace_") && target.action !== "namespace_create") ensure(target.resource_id && state.activeNamespaces.has(target.resource_id) && state.activeNamespaces.get(target.resource_id) === target.role);
    state.intents.set(target.intent_id,target); state.pending.set(target.intent_id,target); return;
  }
  const target=state.pending.get(value.kind === "capture" ? value.capture.intent_id : value.receipt.intent_id); ensure(target);
  if(value.kind === "capture") {
    ensure(["lease_acquire","namespace_create"].includes(target.action));
    ensure(!state.captures.has(target.intent_id));
    state.captures.set(target.intent_id,value.capture);
    if(target.action === "namespace_create") { ensure(!state.namespaces.has(value.capture.resource_id)); state.namespaces.add(value.capture.resource_id); state.activeNamespaces.set(value.capture.resource_id,target.role); }
    return;
  }
  const result=value.receipt, captured=state.captures.get(target.intent_id);
  if(result.outcome === "rejected_before_dispatch") ensure(!captured);
  else if(target.action === "lease_acquire") {
    ensure(result.lease_id && result.resource_id === undefined && !state.lease && (!captured || captured.resource_id === result.lease_id));
    state.lease=result.lease_id;
  } else if(target.action === "lease_release") {
    ensure(result.lease_id === state.lease && result.resource_id === undefined && state.pending.size === 1 && state.activeNamespaces.size === 0); state.released=true;
  } else {
    ensure(result.lease_id === undefined);
    if(target.action === "namespace_create") { ensure(result.resource_id && (!captured || captured.resource_id === result.resource_id) && (captured || !state.namespaces.has(result.resource_id))); state.namespaces.add(result.resource_id); state.activeNamespaces.set(result.resource_id,target.role); }
    else { ensure(result.resource_id === undefined || result.resource_id === target.resource_id); if(target.action === "namespace_remove") state.activeNamespaces.delete(target.resource_id!); }
  }
  state.pending.delete(target.intent_id);
}
function cloneState(state: State): State { return {...state,intents:new Map(state.intents),pending:new Map(state.pending),captures:new Map(state.captures),namespaces:new Set(state.namespaces),activeNamespaces:new Map(state.activeNamespaces)}; }
function snapshot(state: State): OperationJournalSnapshot { return {identity:{...state.identity},...(state.lease ? {lease_id:state.lease} : {}),namespace_ids:[...state.namespaces],captures:[...state.captures.values()].map(value => ({...value})),pending:[...state.pending.values()].map(value => ({...value})),last_sequence:state.sequence,last_hash:state.hash,terminal:state.terminal,durability:state.durability}; }
function directoryName(who: OperationIdentity) { return `op-${who.owner}-${who.operation}`; }
function recordName(sequence: number) { return `${String(sequence).padStart(6,"0")}.json`; }
function safeRoot(root: string) { ensure(typeof root === "string" && path.isAbsolute(root)); return path.resolve(root); }
async function regularDirectory(directory: string) { const stat=await lstat(directory); ensure(stat.isDirectory() && !stat.isSymbolicLink()); }
async function ancestors(directory: string) {
  let cursor=directory;
  while(true) { await regularDirectory(cursor); const parent=path.dirname(cursor); if(parent === cursor) break; cursor=parent; }
}
async function syncDirectory(directory: string) {
  const handle=await open(directory,constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); }
}
async function boundedEntries(directory: string, max: number) {
  const names:string[]=[]; const handle=await opendir(directory);
  for await (const entry of handle) { ensure(names.length < max,"operation_journal_overflow"); names.push(entry.name); }
  return names.sort();
}
async function readState(directory: string, expectedName: string): Promise<State> {
  await regularDirectory(directory);
  const names=await boundedEntries(directory,operationJournalLimits.maxRecords); ensure(names.length > 0);
  let state:State|undefined;
  for(let index=0;index<names.length;index++) {
    ensure(names[index] === recordName(index+1)); const filename=path.join(directory,names[index]); const stat=await lstat(filename);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= operationJournalLimits.maxRecordBytes);
    const handle=await open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let bytes:Buffer;
    try {
      const actual=await handle.stat(); ensure(actual.isFile() && actual.size > 0 && actual.size <= operationJournalLimits.maxRecordBytes);
      const bounded=Buffer.alloc(operationJournalLimits.maxRecordBytes+1); let offset=0;
      while(offset < bounded.length) { const {bytesRead}=await handle.read(bounded,offset,bounded.length-offset,offset); if(bytesRead === 0) break; offset+=bytesRead; }
      ensure(offset > 0 && offset <= operationJournalLimits.maxRecordBytes); bytes=bounded.subarray(0,offset);
    } finally { await handle.close(); }
    let raw:unknown; try { raw=JSON.parse(bytes.toString("utf8")); } catch { throw new JournalError("operation_journal_invalid"); }
    object(raw); keys(raw,["schema","sequence","previous_hash","identity","durability","event","hash"]);
    const who=identity(raw.identity); ensure(directoryName(who) === expectedName);
    ensure(raw.schema === 1 && raw.sequence === index+1 && typeof raw.previous_hash === "string" && id.test(raw.previous_hash) && typeof raw.hash === "string" && id.test(raw.hash) && ["process_crash","file_and_directory_synced"].includes(String(raw.durability)));
    const body:RecordBody={schema:1,sequence:index+1,previous_hash:raw.previous_hash,identity:who,durability:raw.durability as JournalDurability,event:event(raw.event)};
    ensure(raw.hash === digest(body) && bytes.toString("utf8") === `${JSON.stringify({...body,hash:raw.hash})}\n`);
    state ??= initial(who,body.durability);
    ensure(JSON.stringify(state.identity) === JSON.stringify(who) && state.durability === body.durability && state.hash === body.previous_hash);
    apply(state,body.event); state.sequence=body.sequence; state.hash=raw.hash;
  }
  return state!;
}
/** Immutable write-ahead records. This writer cannot adopt an existing operation.
 * Windows file sync covers process crashes; no power-loss namespace durability is claimed.
 * Neither publication nor a verified receipt proves present owner quiescence.
 * Directory checks reject symlinks but are not native confinement against malicious
 * local path replacement between checking and opening; the root must be app-owned.
 */
export async function createOperationJournal(who: OperationIdentity, options: OperationJournalOptions): Promise<OperationJournal> {
  let state:State, directory:string;
  try {
    const checked=identity(who), root=safeRoot(options.root);
    const firstCreated=await mkdir(root,{recursive:true,mode:0o700}); await ancestors(root);
    directory=path.join(root,directoryName(checked));
    try { await mkdir(directory,{mode:0o700}); } catch(error) { if((error as NodeJS.ErrnoException).code === "EEXIST") throw new JournalError("operation_journal_exists"); throw error; }
    if(process.platform !== "win32") {
      const last=firstCreated ? path.dirname(firstCreated) : root;
      let cursor=root; while(true) { await syncDirectory(cursor); const parent=path.dirname(cursor); if(cursor === last || parent === cursor) break; cursor=parent; }
    }
    state=initial(checked,process.platform === "win32" ? "process_crash" : "file_and_directory_synced");
  } catch(error) { throw new JournalError(error instanceof JournalError ? error.code : "operation_journal_io_failed"); }
  let poisoned=false, queue=Promise.resolve();
  async function publish(value: Event) {
    ensure(!poisoned,"operation_journal_writer_failed");
    let temporary:string|undefined, published=false;
    try {
      ensure(state.sequence < operationJournalLimits.maxRecords,"operation_journal_overflow");
      const next=cloneState(state); apply(next,value);
      const body:RecordBody={schema:1,sequence:state.sequence+1,previous_hash:state.hash,identity:{...state.identity},durability:state.durability,event:value};
      const hash=digest(body), text=`${JSON.stringify({...body,hash})}\n`; ensure(Buffer.byteLength(text) <= operationJournalLimits.maxRecordBytes,"operation_journal_overflow");
      await ancestors(directory); await options.publicationFault?.("before_write");
      temporary=path.join(directory,`.pending-${randomUUID()}`);
      const handle=await open(temporary,"wx",0o600);
      try { await handle.writeFile(text,"utf8"); await handle.sync(); } finally { await handle.close(); }
      await options.publicationFault?.("after_file_sync");
      await link(temporary,path.join(directory,recordName(body.sequence))); published=true;
      await options.publicationFault?.("after_publish");
      await unlink(temporary); temporary=undefined;
      if(process.platform !== "win32") await syncDirectory(directory);
      await options.publicationFault?.("after_directory_sync");
      next.sequence=body.sequence; next.hash=hash; state=next;
    } catch(error) {
      poisoned=true;
      // Before publication, no caller may dispatch the corresponding mutation.
      // After publication, leave ambiguous artifacts visible and block inspection.
      if(temporary && !published) { try { await unlink(temporary); } catch {} }
      throw new JournalError(error instanceof JournalError ? error.code : "operation_journal_publish_failed");
    }
  }
  function enqueue(makeEvent: () => Event): Promise<void> {
    // Detach caller-owned metadata at submission, before awaiting earlier writes.
    let prepared:Event|undefined;
    try { prepared=makeEvent(); } catch {}
    const work=queue.then(async () => {
      ensure(!poisoned,"operation_journal_writer_failed");
      try { ensure(prepared); await publish(prepared); } catch(error) { poisoned=true; throw new JournalError(error instanceof JournalError ? error.code : "operation_journal_invalid"); }
    });
    queue=work.catch(() => {}); return work;
  }
  const journal:OperationJournal={identity:Object.freeze({...state.identity}),appendIntent:value => enqueue(() => ({kind:"intent",intent:intent(value)})),appendReceipt:value => enqueue(() => ({kind:"receipt",receipt:receipt(value)})),appendCapture:value => enqueue(() => ({kind:"capture",capture:capture(value)})),complete:() => enqueue(() => ({kind:"complete"})),snapshot:() => snapshot(state)};
  await enqueue(() => ({kind:"begin"})); return journal;
}

/** Read-only catalog. Partial catalogs are never exposed as trustworthy history. */
export async function readOperationJournals(root: string, options: {maxOperations?: number} = {}): Promise<OperationJournalReadResult> {
  try {
    const directory=safeRoot(root), maximum=options.maxOperations ?? operationJournalLimits.defaultOperations;
    ensure(Number.isInteger(maximum) && maximum >= 1 && maximum <= operationJournalLimits.maxOperations);
    try { await ancestors(directory); } catch(error) { if((error as NodeJS.ErrnoException).code === "ENOENT") return {status:"unavailable",reason:"operation_journal_missing",operations:[]}; throw error; }
    const names=await boundedEntries(directory,maximum), operations:OperationJournalSnapshot[]=[];
    for(const name of names) {
      const match=directoryPattern.exec(name); ensure(match && uuid.test(match[1]) && uuid.test(match[2]));
      operations.push(snapshot(await readState(path.join(directory,name),name)));
    }
    return {status:"available",operations};
  } catch(error) {
    const reason=error instanceof JournalError && error.code === "operation_journal_overflow" ? "operation_journal_overflow" : error instanceof JournalError ? "operation_journal_invalid" : "operation_journal_io_failed";
    return {status:"blocked",reason,operations:[]};
  }
}
