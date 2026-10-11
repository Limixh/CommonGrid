// Trusted managed CLI lifecycle. Configuration is supplied only by the native host.
// No host credential path, Docker socket, task workspace or published port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { dockerCommand, DockerCommandError, TaskToolsRuntime } from "./task-runtime.ts";
import { DockerOperationLease, assertOperationLeaseEvidence, operationLeaseFormat, type OperationLeaseIdentity } from "./operation-lease.ts";
import { createOperationJournal, readOperationJournals } from "./operation-journal.ts";
import type { OperationJournal, OperationJournalSnapshot, JournalIntent, JournalReceipt } from "./operation-journal-types.ts";
import { executeTaskTool } from "./task-tool.ts";
import { type SubscriptionProvider } from "./egress-policy.ts";
import { attachManagedControl } from "./managed-control.ts";
import { assertManagedProfileTrust, readManagedHostTrust, installManagedHostTrustScript, verifyManagedHostTrustScript, type ManagedHostTrustOptions, type ManagedProfileTrust } from "./managed-trust.ts";
export type { ManagedHostTrustOptions, ManagedProfileTrust } from "./managed-trust.ts";

export interface ManagedRuntimeAssets {
  baseImage: string;
  binaries: Record<SubscriptionProvider, { binaryPath: string; sha256: string }>;
  bridgeRoot: string;
  journalRoot: string;
  /** Pinned public Codex coding catalog; present only when the build had its source. */
  codexCatalog?: { filePath: string; sha256: string };
}
const bridgeFiles = ["runtime-bridge.mjs", "tunnel-wire.mjs", "mcp.mjs", "task-broker.mjs"] as const;
function safeAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !/[\x00\r\n]/.test(value);
}
export function validateManagedRuntimeAssets(value: ManagedRuntimeAssets): Readonly<ManagedRuntimeAssets> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== (value.codexCatalog === undefined ? "baseImage,binaries,bridgeRoot,journalRoot" : "baseImage,binaries,bridgeRoot,codexCatalog,journalRoot") ||
      typeof value.baseImage !== "string" || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value.baseImage) ||
      !safeAbsolutePath(value.bridgeRoot) || !safeAbsolutePath(value.journalRoot) || !value.binaries || typeof value.binaries !== "object" ||
      Object.keys(value.binaries).sort().join(",") !== "claude,codex") throw new Error("managed_runtime_assets_invalid");
  for (const provider of ["claude", "codex"] as const) {
    const binary = value.binaries[provider];
    if (!binary || typeof binary !== "object" || Array.isArray(binary) || Object.keys(binary).sort().join(",") !== "binaryPath,sha256" ||
        !safeAbsolutePath(binary.binaryPath) || typeof binary.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(binary.sha256)) throw new Error("managed_runtime_assets_invalid");
  }
  const catalog = value.codexCatalog;
  if (catalog !== undefined && (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || Object.keys(catalog).sort().join(",") !== "filePath,sha256" ||
      !safeAbsolutePath(catalog.filePath) || typeof catalog.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(catalog.sha256))) throw new Error("managed_runtime_assets_invalid");
  return Object.freeze({baseImage:value.baseImage, bridgeRoot:value.bridgeRoot, journalRoot:value.journalRoot,
    binaries:Object.freeze({claude:Object.freeze({...value.binaries.claude}), codex:Object.freeze({...value.binaries.codex})}),
    ...(catalog ? {codexCatalog:Object.freeze({...catalog})} : {})});
}
export class ManagedPreparationError extends Error {
  constructor(readonly cleanupVerified: boolean, cause: unknown) {
    super(cause instanceof Error ? cause.message : "managed_prepare_failed", {cause});
    this.name = "ManagedPreparationError";
  }
}
const labelKey = "io.commongrid.spike.owner";
const operationLabelKey = "io.commongrid.spike.operation";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface ManagedContainerEvidence { id: string; owner: string; operation: string; running: boolean; status: string }
export interface ManagedOperationOptions { signal?: AbortSignal }
export interface ManagedRecoveryReceipt { operation: string; lease_id: string; owner_quiesced: true }
function assertActiveSignal(signal?: AbortSignal) { if (signal?.aborted) throw new DockerCommandError("cancelled"); }
// Explicitly inspect only ownership/state. Never load or retain Config.Env,
// process command lines, credential files or Docker's full inspect object.
const evidenceFormat = `{"id":{{json .Id}},"owner":{{json (index .Config.Labels "${labelKey}")}},"operation":{{json (index .Config.Labels "${operationLabelKey}")}},"running":{{json .State.Running}},"status":{{json .State.Status}}}`;
export function assertManagedContainerFence(value: unknown, owner: string, operation?: string, requireStopped = false): asserts value is ManagedContainerEvidence {
  if (requireStopped) assert.ok(typeof operation === "string" && uuidV4.test(operation), "managed_recovery_operation_required");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed_container_evidence_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 5 || Object.keys(record).some(key => !["id", "owner", "operation", "running", "status"].includes(key)) || typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id) || typeof record.running !== "boolean" || typeof record.status !== "string" || !["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(record.status) || typeof record.owner !== "string" || !uuidV4.test(record.owner) || typeof record.operation !== "string" || !uuidV4.test(record.operation)) throw new Error("managed_container_evidence_invalid");
  assert.equal(record.owner, owner, "managed_owner_mismatch");
  if (operation !== undefined) { assert.ok(uuidV4.test(operation), "managed_operation_invalid"); assert.equal(record.operation, operation, "managed_operation_mismatch"); }
  if (requireStopped) assert.ok(record.running === false && ["created", "exited", "dead"].includes(String(record.status)), "managed_recovery_requires_stopped");
}
export async function removeManagedContainer(value: unknown, owner: string, operation: string | undefined, requireStopped = false, invoke: (args: string[]) => Promise<string> = args => checked(args, 30_000, options), options: ManagedOperationOptions = {}) {
  assertActiveSignal(options.signal);
  assertManagedContainerFence(value, owner, operation, requireStopped);
  // Immutable ID prevents name replacement between inspect and removal. A
  // recovery deletion never forces a container that raced back to running.
  await invoke(["rm", ...(requireStopped ? [] : ["--force"]), value.id]);
  assertActiveSignal(options.signal);
  const remaining = await invoke(["container", "ls", "--all", "--no-trunc", "--filter", `id=${value.id}`, "--format", "{{.ID}}"]);
  assertActiveSignal(options.signal);
  assert.ok(!remaining.split(/\r?\n/).includes(value.id), "managed_cleanup_unconfirmed");
}
export async function removeManagedOperationContainer(containerId: string, owner: string, operation: string, invoke: (args: string[]) => Promise<string> = args => checked(args, 30_000, options), options: ManagedOperationOptions = {}) {
  assertActiveSignal(options.signal);
  assert.match(containerId, /^[a-f0-9]{64}$/, "managed_container_id_invalid");
  assert.ok(uuidV4.test(owner), "managed_owner_invalid");
  assert.ok(uuidV4.test(operation), "managed_operation_invalid");
  const listed = await invoke(["container", "ls", "--all", "--no-trunc", "--filter", `id=${containerId}`, "--format", "{{.ID}}"]);
  assertActiveSignal(options.signal);
  if (!listed.split(/\r?\n/).includes(containerId)) return;
  const evidence: unknown = JSON.parse(await invoke(["inspect", "--format", evidenceFormat, containerId]));
  assertActiveSignal(options.signal);
  assertManagedContainerFence(evidence, owner, operation);
  assert.equal(evidence.id, containerId, "managed_container_id_mismatch");
  await removeManagedContainer(evidence, owner, operation, false, invoke, options);
}
export async function checked(args: string[], timeoutMs = 30_000, options: ManagedOperationOptions = {}) {
  assertActiveSignal(options.signal);
  const result = await dockerCommand(args,{...options,timeoutMs});
  assertActiveSignal(options.signal);
  if (result.code !== 0) throw new Error("docker_failed");
  return result.stdout.trim();
}
async function digest(source: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest("hex");
}
export interface SessionIdentity { owner: string; provider: SubscriptionProvider; trust?: ManagedProfileTrust }
export interface ManagedJournalOptions {
  journalFactory?: (identity: {owner:string;provider:string;operation:string}, options:{root:string}) => Promise<OperationJournal>;
}
export interface ManagedRuntimeOptions extends ManagedJournalOptions { assets: ManagedRuntimeAssets }
export interface ManagedPrepareOptions extends ManagedRuntimeOptions { hostTrust?: ManagedHostTrustOptions; signal?: AbortSignal }
export class ManagedCliRuntime {
  readonly owner: string;
  readonly provider: SubscriptionProvider;
  readonly container: string;
  readonly toolsVolume: string;
  readonly authVolume: string;
  protected readonly initContainer: string;
  protected readonly operation = randomUUID();
  private readonly lease: DockerOperationLease;
  private mutating = false;
  private retainedOperations = 0;
  private readonly uncertainVolumeRemovals = new Set<string>();
  private finished = false;
  private readonly uncertainNamespaces = new Set<string>();
  private readonly ownedNamespaceIds = new Set<string>();
  private readonly uncertainVolumes = new Set<string>();
  private profileTrust?: Readonly<ManagedProfileTrust>;
  private starting = false;
  // A canceled create client can lose its ID while the daemon is still working.
  // Absence in a single listing cannot prove that mutation never completed.
  private uncertainCreate = false;
  private journal?: OperationJournal;
  private journalOpening?: Promise<OperationJournal>;
  private journalFailed = false;
  private readonly journalOptions: ManagedJournalOptions;
  protected readonly assets: Readonly<ManagedRuntimeAssets>;
  protected constructor(identity: SessionIdentity, options: ManagedRuntimeOptions) {
    this.assets = validateManagedRuntimeAssets(options?.assets);
    if (!uuidV4.test(identity.owner) || !["claude","codex"].includes(identity.provider)) throw new Error("managed_identity_invalid");
    this.owner = identity.owner; this.provider = identity.provider;
    if (identity.trust !== undefined) { assertManagedProfileTrust(identity.trust, this.owner, this.provider); this.profileTrust = Object.freeze({...identity.trust}); }
    this.container = `cg-managed-${this.provider}-${this.owner}`;
    this.initContainer = `cg-managed-init-${this.owner}`;
    this.toolsVolume = `cg-managed-tools-${this.owner}`;
    this.authVolume = `cg-managed-auth-${this.owner}`;
    this.journalOptions = options;
    this.lease = new DockerOperationLease({owner:this.owner,provider:this.provider,operation:this.operation},this.assets.baseImage,(args,options) => this.journaledCommand(args,options));
  }
  static restore(identity: SessionIdentity, options: ManagedRuntimeOptions) { return new ManagedCliRuntime(identity,options); }
  identity(): SessionIdentity { return {owner:this.owner,provider:this.provider,...(this.profileTrust ? {trust:{...this.profileTrust}} : {})}; }
  operationIdentity() { return { ...this.identity(), operation: this.operation }; }
  leaseIdentity(): OperationLeaseIdentity | undefined { return this.lease.snapshot(); }
  journalSnapshot(): OperationJournalSnapshot | undefined { return this.journal?.snapshot(); }
  private async journalWrite<T>(work: () => Promise<T>) {
    if(this.journalFailed) throw new Error("managed_operation_journal_failed");
    try { return await work(); }
    catch { this.journalFailed=true; throw new Error("managed_operation_journal_failed"); }
  }
  private async openJournal(options: ManagedOperationOptions = {}) {
    assertActiveSignal(options.signal);
    if(this.journalFailed) throw new Error("managed_operation_journal_failed");
    if(!this.journalOpening) this.journalOpening=this.journalWrite(async () => {
      const identity={owner:this.owner,provider:this.provider,operation:this.operation};
      const journal=await (this.journalOptions.journalFactory ?? createOperationJournal)(identity,{root:this.assets.journalRoot});
      assert.deepEqual(journal.identity,identity,"managed_operation_journal_identity_mismatch");
      this.journal=journal; return journal;
    });
    return this.journalOpening;
  }
  private async recordIntent(intent: Omit<JournalIntent,"intent_id">, options: ManagedOperationOptions = {}) {
    const journal=await this.openJournal(options), value={intent_id:randomUUID(),...intent};
    await this.journalWrite(() => journal.appendIntent(value));
    return value;
  }
  private async recordReceipt(receipt: JournalReceipt) { await this.journalWrite(() => this.journal!.appendReceipt(receipt)); }
  private namespaceRole(idOrName: string): "runtime" | "init" {
    if(idOrName === this.initContainer) return "init";
    const snapshot=this.journal?.snapshot();
    const create=snapshot?.pending.find(intent => intent.action === "namespace_create" && snapshot.captures.some(capture => capture.intent_id === intent.intent_id && capture.resource_id === idOrName));
    if(create?.role === "init") return "init";
    // Captured IDs remain associated with their role after their create receipt.
    return this.namespaceRoles.get(idOrName) ?? "runtime";
  }
  private readonly namespaceRoles = new Map<string,"runtime"|"init">();
  private readonly confirmedNamespaceRemovals = new Set<string>();
  private async captureNamespace(id: string, role: "runtime"|"init") {
    this.namespaceRoles.set(id,role);
    for(const intent of this.journal?.snapshot().pending ?? []) if(intent.action === "namespace_create" && intent.role === role) {
      if(!this.journal!.snapshot().captures.some(capture => capture.intent_id === intent.intent_id)) await this.journalWrite(() => this.journal!.appendCapture({intent_id:intent.intent_id,resource_id:id}));
      await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified",resource_id:id});
    }
  }
  private async settleAbsentNamespace(id: string) {
    const snapshot=this.journal?.snapshot();
    if(!snapshot) return;
    let recordedRemoval=false;
    for(const intent of snapshot.pending) {
      const captured=snapshot.captures.find(value => value.intent_id === intent.intent_id)?.resource_id;
      if(intent.action.startsWith("namespace_") && (intent.resource_id === id || captured === id)) {
        await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified",resource_id:id});
        if(intent.action === "namespace_remove") recordedRemoval=true;
      }
    }
    if(!recordedRemoval && snapshot.namespace_ids.includes(id) && !this.confirmedNamespaceRemovals.has(id)) {
      const intent=await this.recordIntent({action:"namespace_remove",role:this.namespaceRole(id),resource_id:id});
      await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified",resource_id:id});
    }
    this.confirmedNamespaceRemovals.add(id);
  }
  private async settleLeaseReceipt() {
    const receipt=this.leaseIdentity();
    if(!receipt) return;
    for(const intent of this.journal?.snapshot().pending ?? []) if(intent.action === "lease_acquire") {
      if(!this.journal!.snapshot().captures.some(capture => capture.intent_id === intent.intent_id)) await this.journalWrite(() => this.journal!.appendCapture({intent_id:intent.intent_id,resource_id:receipt.lease_id}));
      await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified",lease_id:receipt.lease_id});
    }
  }
  private async settleAbsentLease(leaseId: string) {
    for(const intent of this.journal?.snapshot().pending ?? []) if(intent.action === "lease_release") await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified",lease_id:leaseId});
  }
  private async releaseJournaledLease(options: ManagedOperationOptions) {
    const leaseId=this.leaseIdentity()!.lease_id;
    if(!this.journal!.snapshot().pending.some(intent => intent.action === "lease_release")) await this.recordIntent({action:"lease_release"},options);
    await this.lease.release(options);
    // release also verifies a previously removed exact ID without dispatching rm.
    await this.settleAbsentLease(leaseId);
  }
  private async assertDispatchAllowed(intent: JournalIntent, options: ManagedOperationOptions) {
    if(options.signal?.aborted) {
      await this.recordReceipt({intent_id:intent.intent_id,outcome:"rejected_before_dispatch"});
      assertActiveSignal(options.signal);
    }
    if(this.journalFailed) throw new Error("managed_operation_journal_failed");
  }
  private async journaledCommand(args: string[], options: ManagedOperationOptions = {}) {
    let intent: Omit<JournalIntent,"intent_id"> | undefined;
    const leaseName=this.lease.name, target=args.at(-1)!;
    if(args[0] === "create") intent=args.includes(leaseName) ? {action:"lease_acquire"} : {action:"namespace_create",role:args.includes(this.initContainer) ? "init" : "runtime"};
    else if(args[0] === "start") intent={action:"namespace_start",role:this.namespaceRole(target),resource_id:target};
    else if(args[0] === "exec") intent={action:"namespace_exec",role:this.namespaceRole(args[1]),resource_id:args[1]};
    else if(args[0] === "rm") intent=target === this.leaseIdentity()?.lease_id ? {action:"lease_release"} : {action:"namespace_remove",role:this.namespaceRole(target),resource_id:target};
    else if(args[0] === "volume" && ["create","rm"].includes(args[1])) intent={action:args[1] === "create" ? "volume_create" : "volume_remove",role:target === this.authVolume ? "auth" : "tools"};
    if(!intent) return this.command(args,options);
    const recorded=(intent.action === "lease_release" ? this.journal?.snapshot().pending.find(value => value.action === "lease_release") : undefined) ?? await this.recordIntent(intent,options);
    await this.assertDispatchAllowed(recorded,options);
    const result=await this.command(args,options);
    assertActiveSignal(options.signal);
    if(intent.action === "lease_acquire" || intent.action === "namespace_create") {
      assert.match(result,/^[a-f0-9]{64}$/,"managed_container_id_invalid");
      await this.journalWrite(() => this.journal!.appendCapture({intent_id:recorded.intent_id,resource_id:result}));
      if(intent.action === "lease_acquire") {
        const evidence:unknown=JSON.parse(await this.command(["inspect","--format",operationLeaseFormat,result],options));
        assertOperationLeaseEvidence(evidence,{owner:this.owner,provider:this.provider,operation:this.operation},result);
        await this.recordReceipt({intent_id:recorded.intent_id,outcome:"verified",lease_id:result});
      } else {
        const evidence:unknown=JSON.parse(await this.command(["inspect","--format",evidenceFormat,result],options));
        assertManagedContainerFence(evidence,this.owner,this.operation);assert.equal(evidence.id,result,"managed_container_id_mismatch");
        await this.captureNamespace(result,intent.role as "runtime"|"init");
      }
    } else if(intent.action === "namespace_remove" || intent.action === "lease_release") {
      const remaining=await this.command(["container","ls","--all","--no-trunc","--filter",`id=${target}`,"--format","{{.ID}}"],options);
      assert.ok(!remaining.split(/\r?\n/).includes(target),"managed_cleanup_unconfirmed");
      if(intent.action === "namespace_remove") await this.settleAbsentNamespace(target);
      else await this.settleAbsentLease(target);
    } else if(intent.action === "volume_create") {
      assert.equal(await this.command(["volume","inspect","--format",`{{index .Labels "${labelKey}"}}`,target],options),this.owner,"managed_owner_mismatch");
      await this.recordReceipt({intent_id:recorded.intent_id,outcome:"verified"});
    } else if(intent.action === "volume_remove") {
      const remaining=await this.command(["volume","ls","--filter",`name=${target}`,"--format","{{.Name}}"],options);
      assert.ok(!remaining.split(/\r?\n/).includes(target),"managed_cleanup_unconfirmed");
      await this.recordReceipt({intent_id:recorded.intent_id,outcome:"verified"});
    } else {
      const evidence:unknown=JSON.parse(await this.command(["inspect","--format",evidenceFormat,intent.resource_id!],options));
      assertManagedContainerFence(evidence,this.owner,this.operation);assert.equal(evidence.id,intent.resource_id,"managed_container_id_mismatch");
      await this.recordReceipt({intent_id:recorded.intent_id,outcome:"verified",resource_id:intent.resource_id});
    }
    assertActiveSignal(options.signal);
    return result;
  }
  // Work may carry stdin or credentials. Only its container identity is durable.
  async beginNamespaceExec(containerId: string, options: ManagedOperationOptions = {}) {
    await this.lease.verify(options);
    const evidence=await this.containerEvidence(containerId,options);
    assertManagedContainerFence(evidence,this.owner,this.operation);assert.equal(evidence.id,containerId,"managed_container_id_mismatch");
    const intent=await this.recordIntent({action:"namespace_exec",role:this.namespaceRole(containerId),resource_id:containerId},options);
    await this.assertDispatchAllowed(intent,options);
    // Detached/provider work remains pending until exact namespace absence.
    return intent.intent_id;
  }
  async journalNamespaceExec<T>(containerId: string, work: () => Promise<T>, options: ManagedOperationOptions = {}, action: "namespace_exec"|"namespace_start" = "namespace_exec") {
    await this.lease.verify(options);
    const intent=await this.recordIntent({action,role:this.namespaceRole(containerId),resource_id:containerId},options);
    await this.assertDispatchAllowed(intent,options);
    const result=await work();
    assertActiveSignal(options.signal);
    const evidence=await this.containerEvidence(containerId,options);
    assertManagedContainerFence(evidence,this.owner,this.operation);assert.equal(evidence.id,containerId,"managed_container_id_mismatch");
    await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified",resource_id:containerId});
    return result;
  }
  async publishPublicManifest(work: () => Promise<void>, options: ManagedOperationOptions = {}, action: "public_manifest_publish"|"public_checkpoint_publish" = "public_manifest_publish") {
    await this.lease.verify(options);
    const intent=await this.recordIntent({action},options);
    await this.assertDispatchAllowed(intent,options);
    await work();
    assertActiveSignal(options.signal);
    await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified"});
  }
  async publishPublicCheckpoint(work: () => Promise<void>, options: ManagedOperationOptions = {}) { return this.publishPublicManifest(work,options,"public_checkpoint_publish"); }
  protected async mutation<T>(work: () => Promise<T>, requireQuiescence = false) {
    assert.ok(!this.mutating && (!requireQuiescence || this.retainedOperations === 0), "managed_operation_pending");
    this.mutating=true;
    try { return await work(); } finally { this.mutating=false; }
  }
  protected async beginInternal(options: ManagedOperationOptions = {}) {
    assert.ok(!this.finished,"managed_operation_finished");
    await this.openJournal(options);
    try { await this.lease.acquire(options); await this.settleLeaseReceipt(); }
    catch(error) { if(this.journalFailed) throw new Error("managed_operation_journal_failed"); await this.settleLeaseReceipt(); if(error instanceof Error && error.message === "operation_lease_profile_busy") throw new Error("managed_profile_busy"); throw error; }
  }
  async beginOperation(options: ManagedOperationOptions = {}) {
    if(this.leaseIdentity()) { assert.ok(!this.finished,"managed_operation_finished"); await this.lease.verify(options); return; }
    return this.mutation(() => this.beginInternal(options));
  }
  async finishOperation(options: ManagedOperationOptions = {}) {
    return this.mutation(async () => {
      assertActiveSignal(options.signal);
      if(this.journalFailed) throw new Error("managed_operation_journal_failed");
      if(!this.leaseIdentity()) { assert.ok(!this.lease.isUncertain(),"managed_cleanup_unconfirmed"); assert.equal(this.journal?.snapshot().pending.length ?? 0,0,"managed_cleanup_unconfirmed"); return; }
      if(await this.lease.exists(options)) await this.stopInternal(options);
      else { await this.confirmCapturedNamespacesAbsent(options); await this.settleAbsentLease(this.leaseIdentity()!.lease_id); }
      assert.ok(!this.uncertainCreate && this.uncertainNamespaces.size === 0 && this.uncertainVolumes.size === 0 && this.uncertainVolumeRemovals.size === 0,"managed_cleanup_unconfirmed");
      assert.equal(this.journal?.snapshot().pending.filter(intent => intent.action !== "lease_release").length ?? 0,0,"managed_cleanup_unconfirmed");
      await this.releaseJournaledLease(options); await this.journalWrite(() => this.journal!.complete()); this.finished=true;
    },true);
  }
  async retainOperation(options: ManagedOperationOptions = {}) {
    assert.ok(!this.finished && !this.mutating,"managed_operation_pending"); this.retainedOperations++;
    try { await this.lease.verify(options); } catch(error) { this.retainedOperations--; throw error; }
    let released=false; return () => { if(!released) { released=true; this.retainedOperations--; } };
  }
  protected async ownedCommand(args: string[], options: ManagedOperationOptions = {}) {
    if(this.journalFailed) throw new Error("managed_operation_journal_failed");
    await this.lease.verify(options); return this.journaledCommand(args,options);
  }
  private command(args: string[], options: ManagedOperationOptions = {}) { return checked(args, 30_000, options); }
  private async containerEvidence(name: string, options: ManagedOperationOptions = {}) {
    const evidence: unknown = JSON.parse(await this.ownedCommand(["inspect", "--format", evidenceFormat, name], options));
    assertManagedContainerFence(evidence, this.owner);
    if(evidence.operation === this.operation) await this.captureNamespace(evidence.id,this.namespaceRole(name));
    return evidence;
  }
  async verifyOperation(options: ManagedOperationOptions = {}) {
    await this.lease.verify(options);
    const evidence = await this.containerEvidence(this.container, options);
    assertManagedContainerFence(evidence, this.owner, this.operation);
    assert.equal(evidence.running, true, "managed_operation_not_running");
    return evidence.id;
  }
  async verify(kind: "container" | "volume", name: string, options: ManagedOperationOptions = {}) {
    const field = kind === "container" ? ".Config.Labels" : ".Labels";
    assert.equal(await this.ownedCommand([kind === "container" ? "inspect" : "volume", ...(kind === "container" ? [] : ["inspect"]),"--format",`{{index ${field} "${labelKey}"}}`,name], options),this.owner,"managed_owner_mismatch");
    if(kind === "volume") for(const intent of this.journal?.snapshot().pending ?? []) if(intent.action === "volume_create" && intent.role === (name === this.authVolume ? "auth" : "tools")) await this.recordReceipt({intent_id:intent.intent_id,outcome:"verified"});
  }
  static async prepare(provider: SubscriptionProvider, options: ManagedPrepareOptions) {
    try { return await this.prepareRuntime(new ManagedCliRuntime({owner:randomUUID(),provider},options),options); }
    catch(error) { if(error instanceof ManagedPreparationError) throw error; throw new ManagedPreparationError(true,error); }
  }
  protected static async prepareRuntime<T extends ManagedCliRuntime>(runtime: T, options: ManagedPrepareOptions): Promise<T> {
    const provider = runtime.provider;
    let extra: Awaited<ReturnType<typeof readManagedHostTrust>> | undefined;
    const source = runtime.assets.binaries[provider].binaryPath;
    try {
      if (options.hostTrust !== undefined) assert.equal(provider, "claude", "managed_profile_trust_provider_invalid");
      extra = options.hostTrust !== undefined ? await readManagedHostTrust(options.hostTrust, runtime.owner) : undefined;
      if (extra) runtime.profileTrust = Object.freeze({...extra.trust});
      // Public delivery is fully preflighted before any journal/daemon mutation.
      for (const file of [source,...bridgeFiles.map(file => path.join(runtime.assets.bridgeRoot,file))]) {
        assertActiveSignal(options.signal);
        try { const stat=await lstat(file); if(!stat.isFile() || stat.isSymbolicLink()) throw new Error(); }
        catch { throw new Error("managed_runtime_asset_unavailable"); }
      }
      if (await digest(source) !== runtime.assets.binaries[provider].sha256) throw new Error("managed_binary_digest_invalid");
      for (const file of bridgeFiles) await digest(path.join(runtime.assets.bridgeRoot,file));
      assertActiveSignal(options.signal);
    } catch(error) { throw new ManagedPreparationError(true,error); }
    try {
      await runtime.beginOperation(options);
      for(const volume of [runtime.toolsVolume,runtime.authVolume]) {
        runtime.uncertainVolumes.add(volume);
        await runtime.ownedCommand(["volume","create","--label",`${labelKey}=${runtime.owner}`,volume],options);
        await runtime.verify("volume",volume,options); runtime.uncertainVolumes.delete(volume);
      }
      runtime.uncertainNamespaces.add(runtime.initContainer);
      const initId = await runtime.ownedCommand(["create","--name",runtime.initContainer,"--label",`${labelKey}=${runtime.owner}`,"--label",`io.commongrid.spike.operation=${runtime.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--cap-add","CHOWN","--security-opt","no-new-privileges","--memory","512m","--memory-swap","512m","--pids-limit","32",
        "--mount",`type=volume,src=${runtime.toolsVolume},dst=/opt/cg,volume-nocopy`,"--mount",`type=volume,src=${runtime.authVolume},dst=/home/node,volume-nocopy`,runtime.assets.baseImage,"node","-e","setTimeout(()=>process.exit(0),600000)"],options);
      assert.match(initId, /^[a-f0-9]{64}$/, "managed_container_id_invalid");
      runtime.ownedNamespaceIds.add(initId);
      const initEvidence = await runtime.containerEvidence(initId,options);
      assertManagedContainerFence(initEvidence, runtime.owner, runtime.operation);
      assert.equal(initEvidence.id, initId, "managed_container_id_mismatch");
      runtime.uncertainNamespaces.delete(runtime.initContainer);
      await runtime.ownedCommand(["start",initId],options);
      for (const [from,to] of [[source,`/opt/cg/${provider}`],...bridgeFiles.map(file => [path.join(runtime.assets.bridgeRoot,file),`/opt/cg/${file}`])]) {
        await runtime.lease.verify(options);
        const result = await runtime.journalNamespaceExec(initId,()=>dockerCommand(["exec","-i",initId,"node","-e","const fs=require('node:fs');const o=fs.createWriteStream(process.argv[1],{flags:'wx',mode:0o555});o.on('error',()=>process.exit(1));process.stdin.pipe(o)",to],{signal:options.signal,timeoutMs:180_000,stdin:createReadStream(from)}),options);
        assert.equal(result.code,0,"managed_public_delivery_failed");
      }
      await runtime.ownedCommand(["exec",initId,"node","-e","require('node:fs').writeFileSync('/opt/cg/ca.pem',require('node:tls').rootCertificates.join('\\n')+'\\n',{flag:'wx',mode:0o444});"],options);
      // Only an explicit selection installs an extra public root. The default
      // profile uses the pinned image's bundled roots on every machine.
      if (extra) await runtime.ownedCommand(["exec",initId,"node","-e",installManagedHostTrustScript,"--",extra.pem,JSON.stringify(extra.trust)],options);
      await runtime.ownedCommand(["exec",initId,"/bin/chmod","0700","/home/node"],options);
      await runtime.ownedCommand(["exec",initId,"/bin/chown","1000:1000","/home/node"],options);
      await runtime.ownedCommand(["exec",initId,"/bin/chmod","0555","/opt/cg"],options);
      await runtime.stopOperationContainer(initId,options);
      return runtime;
    } catch (error) {
      try { await runtime.destroy({signal:AbortSignal.timeout(30_000)}); }
      catch (cleanupError) { throw new ManagedPreparationError(false,new AggregateError([error, cleanupError], "managed_prepare_cleanup_unconfirmed")); }
      throw new ManagedPreparationError(true,error);
    }
  }
  async installTrustBundle(options: ManagedOperationOptions = {}) { return this.mutation(() => this.installTrustBundleInternal(options),true); }
  private async installTrustBundleInternal(options: ManagedOperationOptions) {
    await this.beginInternal(options);
    // Repair an already prepared public cache from the same pinned image. Never
    // mount auth, use host trust files, disable TLS or update an active profile.
    assert.equal(await this.ownedCommand(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"],options),"","managed_profile_busy");
    await this.verify("volume",this.toolsVolume,options);
    const script="const f=require('node:fs'),bundle=require('node:tls').rootCertificates.join('\\n')+'\\n';if(f.existsSync('/opt/cg/ca.pem')){if(f.readFileSync('/opt/cg/ca.pem','utf8')!==bundle)throw Error('invalid_bundle');}else{f.chmodSync('/opt/cg',0o755);try{f.writeFileSync('/opt/cg/ca.pem',bundle,{flag:'wx',mode:0o444});}finally{f.chmodSync('/opt/cg',0o555);}}";
    await this.installContainer(["create","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,this.assets.baseImage,"node","-e",script],undefined,options);
  }
  /** Installs or repairs the pinned public Codex coding catalog in the profile's tools volume. Never mounts auth. */
  async installCodexCodingCatalog(options: ManagedOperationOptions = {}) { return this.mutation(() => this.installCodexCodingCatalogInternal(options),true); }
  private async installCodexCodingCatalogInternal(options: ManagedOperationOptions) {
    assert.equal(this.provider,"codex","managed_catalog_provider_invalid");
    const pin=this.assets.codexCatalog; if(!pin) throw new Error("managed_catalog_asset_missing");
    const stat=await lstat(pin.filePath); if(!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error("managed_catalog_asset_invalid");
    const catalog=await readFile(pin.filePath); if(catalog.length > 262_144 || createHash("sha256").update(catalog).digest("hex") !== pin.sha256) throw new Error("managed_catalog_digest_invalid");
    await this.beginInternal(options);
    assert.equal(await this.ownedCommand(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"],options),"","managed_profile_busy");await this.verify("volume",this.toolsVolume,options);
    // Public cache file: a different earlier pin is replaced atomically inside the init container only.
    const script="const f=require('node:fs'),catalog=f.readFileSync(0,'utf8'),p='/opt/cg/catalog.json',t='/opt/cg/.catalog.tmp';f.chmodSync('/opt/cg',0o755);try{if(!f.existsSync(p)||f.readFileSync(p,'utf8')!==catalog){f.rmSync(t,{force:true});f.writeFileSync(t,catalog,{flag:'wx',mode:0o444});f.renameSync(t,p);}}finally{f.chmodSync('/opt/cg',0o555);}";
    await this.installContainer(["create","-i","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`${operationLabelKey}=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,this.assets.baseImage,"node","-e",script],Readable.from([catalog]),options);
  }
  async installClaudeHostTrust(options: ManagedHostTrustOptions, operationOptions: ManagedOperationOptions = {}) { return this.mutation(() => this.installClaudeHostTrustInternal(options,operationOptions),true); }
  private async installClaudeHostTrustInternal(options: ManagedHostTrustOptions, operationOptions: ManagedOperationOptions) {
    assert.equal(this.provider,"claude");const extra=await readManagedHostTrust(options,this.owner);
    if (this.profileTrust) assert.deepEqual(extra.trust,this.profileTrust,"managed_profile_trust_mismatch");
    await this.beginInternal(operationOptions);
    assert.equal(await this.ownedCommand(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"],operationOptions),"","managed_profile_busy");await this.verify("volume",this.toolsVolume,operationOptions);
    await this.installContainer(["create","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,this.assets.baseImage,"node","-e",installManagedHostTrustScript,"--",extra.pem,JSON.stringify(extra.trust)],undefined,operationOptions);
    this.profileTrust = Object.freeze({...extra.trust});
  }
  protected async installContainer(args: string[], stdin: Readable | undefined, options: ManagedOperationOptions) {
    let containerId: string | undefined;
    await this.lease.verify(options); this.uncertainNamespaces.add(this.initContainer);
    try {
      containerId=await this.ownedCommand(args,options);
      assert.match(containerId,/^[a-f0-9]{64}$/,"managed_container_id_invalid");
      this.ownedNamespaceIds.add(containerId);
      const evidence=await this.containerEvidence(containerId,options);
      assertManagedContainerFence(evidence,this.owner,this.operation);
      assert.equal(evidence.id,containerId,"managed_container_id_mismatch");
      this.uncertainNamespaces.delete(this.initContainer);
      const startArgs=["start","--attach",...(stdin ? ["--interactive"] : []),containerId];
      if(stdin) {
        await this.lease.verify(options);
        const result=await this.journalNamespaceExec(containerId,()=>dockerCommand(startArgs,{signal:options.signal,timeoutMs:30_000,stdin}),options,"namespace_start");
        assert.equal(result.code,0,"managed_public_delivery_failed");
      } else await this.ownedCommand(startArgs,options);
    } finally {
      const cleanup={signal:AbortSignal.timeout(30_000)};
      if(containerId && /^[a-f0-9]{64}$/.test(containerId)) {
        await this.stopOperationContainer(containerId,cleanup); this.uncertainNamespaces.delete(this.initContainer);
      } else await this.stopInternal(cleanup);
    }
  }
  async start(options: ManagedOperationOptions = {}) { return this.mutation(() => this.startInternal(options),true); }
  private async startInternal(options: ManagedOperationOptions = {}) {
    await this.beginInternal(options);
    assertActiveSignal(options.signal);
    assert.ok(!this.starting, "managed_start_in_progress");
    assert.ok(!this.uncertainCreate, "managed_cleanup_unconfirmed");
    this.starting = true;
    let createDispatched = false, containerId: string | undefined;
    const invoke = (args: string[]) => this.ownedCommand(args, options);
    try {
    await this.verify("volume",this.authVolume, options); await this.verify("volume",this.toolsVolume, options);
    assert.equal(await invoke(["container", "ls", "--all", "--filter", `name=^/${this.container}$`, "--format", "{{.Names}}"]), "", "managed_profile_busy");
    const trust=this.profileTrust;
    const ca=trust?"/opt/cg/optional-public-ca.pem":"/opt/cg/ca.pem";
    assertActiveSignal(options.signal);
    createDispatched = true; this.uncertainCreate=true;
    containerId = await invoke(["create","--name",this.container,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","1000:1000","--workdir","/home/node","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","96","--cpus","1","--memory","1024m","--memory-swap","1024m","--init",
      "--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,readonly,volume-nocopy`,"--mount",`type=volume,src=${this.authVolume},dst=/home/node,volume-nocopy`,"--tmpfs","/tmp:rw,noexec,nosuid,size=128m",
      "--env","HTTPS_PROXY=http://127.0.0.1:9877","--env","HTTP_PROXY=http://127.0.0.1:9877","--env","ALL_PROXY=http://127.0.0.1:9877","--env","NO_PROXY=127.0.0.1,localhost",
      "--env","CODEX_CA_CERTIFICATE=/opt/cg/ca.pem","--env",`SSL_CERT_FILE=${ca}`,
      "--env",`NODE_EXTRA_CA_CERTS=${ca}`,
      "--env","CLAUDE_CONFIG_DIR=/home/node/claude","--env","DISABLE_AUTOUPDATER=1","--env","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1","--env","ENABLE_CLAUDEAI_MCP_SERVERS=false","--env","ENABLE_TOOL_SEARCH=false","--env","CLAUDE_CODE_DISABLE_ARTIFACT=1",
      "--env",`CG_TOOL_TOKEN=${randomBytes(32).toString("hex")}`,this.assets.baseImage,"node","-e","setTimeout(()=>process.exit(0),900000)"]);
    assert.match(containerId, /^[a-f0-9]{64}$/, "managed_container_id_invalid");
      this.ownedNamespaceIds.add(containerId);
      const evidence = await this.containerEvidence(containerId, options);
      assertManagedContainerFence(evidence, this.owner, this.operation);
      assert.equal(evidence.id, containerId, "managed_container_id_mismatch");
      this.uncertainCreate=false;
      await invoke(["start",containerId]);
      const hash = await invoke(["exec",containerId,"node","-e",`const fs=require('node:fs'),c=require('node:crypto'),h=c.createHash('sha256');const s=fs.createReadStream('/opt/cg/${this.provider}');s.on('data',b=>h.update(b));s.on('end',()=>console.log(h.digest('hex')));`]);
      assert.equal(hash,this.assets.binaries[this.provider].sha256,"managed_binary_tampered");
      for(const file of bridgeFiles) {
        const actual=await invoke(["exec",containerId,"node","-e",`console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/opt/cg/${file}')).digest('hex'));`]);
        assert.equal(actual,await digest(path.join(this.assets.bridgeRoot,file)),"managed_bridge_source_changed_reprepare_required");
      }
      assert.equal(await invoke(["exec",containerId,"node","-e","console.log(require('node:fs').readFileSync('/opt/cg/ca.pem','utf8')===require('node:tls').rootCertificates.join('\\n')+'\\n');"]),"true","managed_trust_bundle_invalid");
      if(trust)assert.equal(await invoke(["exec",containerId,"node","-e",verifyManagedHostTrustScript,"--",JSON.stringify(trust)]),"true","managed_host_trust_bundle_invalid");
      assertActiveSignal(options.signal);
    } catch (error) {
      if (createDispatched) {
        // The canceled create client may lose its returned ID. Reconcile only
        // this operation, with a fresh deadline independent of caller abort.
        const cleanupOptions = { signal: AbortSignal.timeout(30_000) };
        if (!containerId && error instanceof DockerCommandError) this.uncertainCreate = true;
        if (containerId !== undefined && !/^[a-f0-9]{64}$/.test(containerId)) this.uncertainCreate = true;
        try {
          if (containerId && /^[a-f0-9]{64}$/.test(containerId)) { await this.stopOperationContainer(containerId, cleanupOptions); this.uncertainCreate=false; }
          else await this.stopInternal(cleanupOptions);
        } catch (cleanupError) { throw new AggregateError([error, cleanupError], "managed_start_cleanup_unconfirmed"); }
      }
      throw error;
    } finally { this.starting = false; }
  }
  async exec(args: string[], timeoutMs = 15_000, options: { signal?: AbortSignal; maxBytes?: number } = {}) {
    const release=await this.retainOperation(options);
    try { return await this.execInternal(args,timeoutMs,options); } finally { release(); }
  }
  private async execInternal(args: string[], timeoutMs: number, options: { signal?: AbortSignal; maxBytes?: number }) {
    assertActiveSignal(options.signal);
    if (!args.length || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1_048_576))) throw new Error("managed_exec_arguments_invalid");
    const containerId = await this.verifyOperation(options);
    try { return await this.journalNamespaceExec(containerId,() => dockerCommand(["exec",containerId,...args],{...options,timeoutMs}),options); }
    catch(error) {
      // Killing a Docker client does not guarantee its exec descendants exit.
      // Tear down only this operation; its private home remains on the volume.
      // Capture the dispatched ID: a replacement with even the same operation
      // label must survive this older exec's asynchronous cleanup.
      await this.stopOperationContainer(containerId, { signal: AbortSignal.timeout(30_000) }); throw error;
    }
  }
  private async stopOperationContainer(containerId: string, options: ManagedOperationOptions = {}) {
    await removeManagedOperationContainer(containerId, this.owner, this.operation, args => this.ownedCommand(args, options), options);
    // The helper also returns after proving an already-removed exact ID absent.
    // Settle dispatched execs in that path before dropping the in-memory ID.
    await this.settleAbsentNamespace(containerId);
    this.ownedNamespaceIds.delete(containerId);
  }
  async stop(explicitDestroy = false, options: ManagedOperationOptions = {}) {
    assert.ok(!explicitDestroy,"managed_owner_wide_cleanup_denied");
    return this.mutation(() => this.stopInternal(options));
  }
  private async stopInternal(options: ManagedOperationOptions = {}) {
    assertActiveSignal(options.signal);
    if(!this.leaseIdentity()) { assert.ok(!this.lease.isUncertain(),"managed_cleanup_unconfirmed"); return; }
    if(!await this.lease.exists(options)) { await this.confirmCapturedNamespacesAbsent(options); assert.ok(!this.uncertainCreate && this.uncertainNamespaces.size === 0 && this.uncertainVolumes.size === 0 && this.uncertainVolumeRemovals.size === 0,"managed_cleanup_unconfirmed"); return; }
    await this.lease.verify(options);
    for (const name of [this.container,this.initContainer]) {
      const listed=await this.ownedCommand(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"],options);
      if(!listed.split(/\r?\n/).includes(name)) continue;
      const evidence=await this.containerEvidence(name,options);
      assertManagedContainerFence(evidence,this.owner,this.operation);
      await removeManagedContainer(evidence,this.owner,this.operation,false,args => this.ownedCommand(args,options),options);
      this.ownedNamespaceIds.delete(evidence.id);
      this.uncertainNamespaces.delete(name);
      if(name === this.container) this.uncertainCreate=false;
    }
    assertActiveSignal(options.signal);
    await this.confirmCapturedNamespacesAbsent(options);
    assert.ok(!this.uncertainCreate && this.uncertainNamespaces.size === 0 && this.uncertainVolumes.size === 0 && this.uncertainVolumeRemovals.size === 0,"managed_cleanup_unconfirmed");
  }
  private async confirmCapturedNamespacesAbsent(options: ManagedOperationOptions) {
    for(const id of [...this.ownedNamespaceIds]) {
      const listed=await this.command(["container","ls","--all","--no-trunc","--filter",`id=${id}`,"--format","{{.ID}}"],options);
      assertActiveSignal(options.signal);
      assert.ok(!listed.split(/\r?\n/).includes(id),"managed_cleanup_unconfirmed");
      await this.settleAbsentNamespace(id);
      this.ownedNamespaceIds.delete(id);
    }
  }
  async recoverStopped(receipt: ManagedRecoveryReceipt, options: ManagedOperationOptions = {}) {
    return this.mutation(async () => {
      assertActiveSignal(options.signal);
      assert.ok(receipt && typeof receipt === "object" && receipt.owner_quiesced === true,"managed_recovery_quiescence_required");
      assert.ok(uuidV4.test(receipt.operation),"managed_operation_invalid");
      assert.ok(!this.journalFailed,"managed_operation_journal_failed");
      assert.ok(!this.leaseIdentity() && !this.lease.isUncertain() && !this.finished,"managed_recovery_claim_conflict");
      // The explicit acknowledgement cannot settle an old owner's dispatched,
      // uncaptured mutation. Only a fully validated durable history can fence
      // the exact namespaces this separate legacy helper may remove.
      const catalog=await readOperationJournals(this.assets.journalRoot);
      assertActiveSignal(options.signal);
      assert.equal(catalog.status,"available","managed_recovery_journal_unavailable");
      const matches=catalog.operations.filter(value => value.identity.owner === this.owner && value.identity.provider === this.provider && value.identity.operation === receipt.operation);
      assert.equal(matches.length,1,"managed_recovery_journal_identity_mismatch");
      const oldJournal=matches[0];
      assert.equal(oldJournal.lease_id,receipt.lease_id,"managed_recovery_journal_lease_mismatch");
      assert.equal(oldJournal.pending.length,0,"managed_recovery_journal_pending");
      assert.equal(oldJournal.terminal,false,"managed_recovery_journal_terminal");
      const lease=await DockerOperationLease.inspectReceipt({owner:this.owner,provider:this.provider,operation:receipt.operation,lease_id:receipt.lease_id},this.assets.baseImage,(args,callOptions) => this.command(args,callOptions),options);
      const invoke=async (args:string[]) => { await lease.verify(options); return this.command(args,options); };
      const recordedIds=new Set(oldJournal.namespace_ids), captured=new Map<string,ManagedContainerEvidence>();
      const inventory=await invoke(["container","ls","--all","--no-trunc","--filter",`label=${labelKey}=${this.owner}`,"--filter",`label=${operationLabelKey}=${receipt.operation}`,"--format","{{.ID}}"]);
      for(const presentId of inventory.split(/\r?\n/).filter(Boolean)) {
        assert.match(presentId,/^[a-f0-9]{64}$/,"managed_container_id_invalid");
        if(presentId !== receipt.lease_id) assert.ok(recordedIds.has(presentId),"managed_recovery_namespace_unrecorded");
      }
      for(const name of [this.container,this.initContainer]) {
        const listed=await invoke(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"]);
        if(!listed.split(/\r?\n/).includes(name)) continue;
        const evidence:unknown=JSON.parse(await invoke(["inspect","--format",evidenceFormat,name]));
        assertManagedContainerFence(evidence,this.owner,receipt.operation,true);
        assert.ok(recordedIds.has(evidence.id),"managed_recovery_namespace_unrecorded"); captured.set(evidence.id,evidence);
      }
      // A captured container may have been renamed or relabelled. Validate
      // every still-present immutable ID before deleting even the first one.
      for(const namespaceId of recordedIds) {
        if(captured.has(namespaceId)) continue;
        const listed=await invoke(["container","ls","--all","--no-trunc","--filter",`id=${namespaceId}`,"--format","{{.ID}}"]);
        if(!listed.split(/\r?\n/).includes(namespaceId)) continue;
        const evidence:unknown=JSON.parse(await invoke(["inspect","--format",evidenceFormat,namespaceId]));
        assertManagedContainerFence(evidence,this.owner,receipt.operation,true);
        assert.equal(evidence.id,namespaceId,"managed_container_id_mismatch"); captured.set(namespaceId,evidence);
      }
      assert.ok(captured.size > 0,"managed_recovery_namespace_absent");
      for(const evidence of captured.values()) await removeManagedContainer(evidence,this.owner,receipt.operation,true,invoke,options);
      await lease.release(options);
      // The old owner remains responsible for recording external absence and
      // completing its journal; this helper has no authority to rewrite it.
      return {recovered_containers:captured.size,private_volumes_retained:true};
    });
  }
  async destroy(options: ManagedOperationOptions = {}) {
    return this.mutation(async () => {
      await this.beginInternal(options);
      assert.ok(this.uncertainVolumeRemovals.size === 0,"managed_cleanup_unconfirmed");
      for(const name of [...this.uncertainVolumes]) { await this.verify("volume",name,options); this.uncertainVolumes.delete(name); }
      await this.stopInternal(options);
      for(const name of [this.authVolume,this.toolsVolume]) {
        const listed=await this.ownedCommand(["volume","ls","--filter",`name=${name}`,"--format","{{.Name}}"],options);
        if(!listed.split(/\r?\n/).includes(name)) continue;
        await this.verify("volume",name,options);
        this.uncertainVolumeRemovals.add(name);
        await this.ownedCommand(["volume","rm",name],options);
        assert.ok(!(await this.ownedCommand(["volume","ls","--filter",`name=${name}`,"--format","{{.Name}}"],options)).split(/\r?\n/).includes(name),"managed_cleanup_unconfirmed");
        this.uncertainVolumeRemovals.delete(name);
      }
      assert.equal(this.journal?.snapshot().pending.length ?? 0,0,"managed_cleanup_unconfirmed");
      await this.releaseJournaledLease(options); await this.journalWrite(() => this.journal!.complete()); this.finished=true;
    },true);
  }
}

export async function startBridge(runtime: ManagedCliRuntime, task?: TaskToolsRuntime, signal?: AbortSignal) {
  const release=await runtime.retainOperation();
  let containerId:string;
  try { containerId=await runtime.verifyOperation(); } catch(error) { release(); throw error; }
  try { await runtime.beginNamespaceExec(containerId); } catch(error) { release(); throw error; }
  const child = spawn("docker",["exec","-i",containerId,"node","/opt/cg/runtime-bridge.mjs"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let taskCallback: Promise<unknown> | undefined;
  const control = attachManagedControl(child, {provider:runtime.provider, ...(task ? {execute: (arguments_: unknown) => {
    taskCallback = executeTaskTool(task, arguments_, signal); return taskCallback;
  }} : {})});
  const close=() => {
    control.close();
    // Native task cancellation must settle relay callbacks before the caller
    // closes the sandbox. Legacy non-task/session callers keep synchronous close.
    if (signal && taskCallback) return taskCallback.then(() => { release(); });
    release();
  };
  child.once("close",release);
  try { await control.ready; assert.equal(control.stats.control_failure,false,"managed_bridge_failed"); release(); } catch (error) { await close(); throw error; }
  return {stats:control.stats,close,child:control.child};
}
