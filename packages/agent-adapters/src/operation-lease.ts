import { dockerCommand, DockerCommandError } from "./task-runtime.ts";

function ensure(condition: unknown, code: string): asserts condition { if(!condition) throw new Error(code); }

export interface OperationIdentity { owner: string; provider: string; operation: string }
export interface OperationLeaseIdentity extends OperationIdentity { lease_id: string }
export interface LeaseOptions { signal?: AbortSignal }
export type LeaseCommand = (args: string[], options: LeaseOptions) => Promise<string>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idPattern = /^[a-f0-9]{64}$/;
export const operationLeaseLabels = {
  owner: "io.commongrid.operation.owner", provider: "io.commongrid.operation.provider",
  operation: "io.commongrid.operation.id", kind: "io.commongrid.operation.kind", schema: "io.commongrid.operation.schema",
} as const;
const fields = Object.entries(operationLeaseLabels).map(([key, label]) => `"${key}":{{json (index .Config.Labels "${label}")}}`).join(",");
// This deliberately excludes Docker environment, commands, logs and auth data.
export const operationLeaseFormat = `{"id":{{json .Id}},"name":{{json .Name}},${fields},"running":{{json .State.Running}},"status":{{json .State.Status}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{len .Mounts}},"ports":{{len .HostConfig.PortBindings}}}`;
export function assertLeaseIdentity(value: OperationIdentity) {
  ensure(value && typeof value.owner === "string" && typeof value.operation === "string" && typeof value.provider === "string" && uuid.test(value.owner) && uuid.test(value.operation) && /^[a-z][a-z0-9-]{0,31}$/.test(value.provider), "operation_lease_identity_invalid");
}
export function assertOperationLeaseEvidence(value: unknown, identity: OperationIdentity, leaseId?: string): asserts value is {id:string} {
  assertLeaseIdentity(identity);
  ensure(value && typeof value === "object" && !Array.isArray(value), "operation_lease_evidence_invalid");
  const record = value as Record<string, unknown>;
  ensure(Object.keys(record).sort().join(",") === ["id","name","owner","provider","operation","kind","schema","running","status","network","readonly","mounts","ports"].sort().join(","), "operation_lease_evidence_invalid");
  ensure(typeof record.id === "string" && idPattern.test(record.id), "operation_lease_evidence_invalid");
  ensure(record.name === `/cg-managed-lease-${identity.owner}`, "operation_lease_mismatch");
  for (const key of ["owner", "provider", "operation"] as const) ensure(record[key] === identity[key], "operation_lease_mismatch");
  if (leaseId !== undefined) { ensure(typeof leaseId === "string" && idPattern.test(leaseId),"operation_lease_id_invalid"); ensure(record.id === leaseId,"operation_lease_mismatch"); }
  ensure(record.kind === "managed-profile-claim" && record.schema === "1" && record.running === false && record.status === "created" && record.network === "none" && record.readonly === true && record.mounts === 0 && record.ports === 0, "operation_lease_unsafe");
}
const defaultCommand: LeaseCommand = async (args, options) => {
  const result = await dockerCommand(args,{...options,timeoutMs:30_000});
  if (result.code !== 0) throw new Error("docker_failed");
  return result.stdout.trim();
};
function active(options: LeaseOptions) { if (options.signal?.aborted) throw new DockerCommandError("cancelled"); }

/** A never-started Docker container is the durable, exclusive profile claim.
 * Docker name uniqueness arbitrates contenders; no age or PID implies consent.
 * An uncertain create is reconciled only by exact immutable ownership evidence.
 */
export class DockerOperationLease {
  readonly name: string;
  private leaseId?: string;
  private uncertain = false;
  private busy = false;
  constructor(readonly identity: Readonly<OperationIdentity>, private readonly image: string, private readonly invoke: LeaseCommand = defaultCommand) {
    assertLeaseIdentity(identity); ensure(typeof image === "string" && /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image),"operation_lease_image_invalid");
    this.identity = Object.freeze({owner:identity.owner,provider:identity.provider,operation:identity.operation}); this.name = `cg-managed-lease-${identity.owner}`;
  }
  isUncertain() { return this.uncertain; }
  async exists(options: LeaseOptions = {}) {
    active(options); ensure(this.leaseId,"operation_lease_required");
    const listed=await this.invoke(["container","ls","--all","--no-trunc","--filter",`id=${this.leaseId}`,"--format","{{.ID}}"],options); active(options);
    return listed.split(/\r?\n/).includes(this.leaseId);
  }
  snapshot(): OperationLeaseIdentity | undefined { return this.leaseId ? {...this.identity,lease_id:this.leaseId} : undefined; }
  private async inspect(reference: string, options: LeaseOptions) {
    active(options); const output=await this.invoke(["inspect","--format",operationLeaseFormat,reference],options); active(options);
    try { return JSON.parse(output) as unknown; } catch { throw new Error("operation_lease_evidence_invalid"); }
  }
  async verify(options: LeaseOptions = {}) {
    active(options); ensure(this.leaseId,"operation_lease_required");
    const evidence = await this.inspect(this.leaseId,options); active(options);
    assertOperationLeaseEvidence(evidence,this.identity,this.leaseId); return this.snapshot()!;
  }
  async acquire(options: LeaseOptions = {}) {
    active(options); ensure(!this.busy,"operation_lease_busy"); this.busy=true;
    try {
      if (this.leaseId) return await this.verify(options);
      if (this.uncertain) return await this.reconcile(options);
      const incumbent=await this.invoke(["container","ls","--all","--filter",`name=^/${this.name}$`,"--format","{{.Names}}"],options); active(options);
      if(incumbent.split(/\r?\n/).includes(this.name)) throw new Error("operation_lease_profile_busy");
      this.uncertain=true;
      try {
        const id=await this.invoke(["create","--name",this.name,...Object.entries(operationLeaseLabels).flatMap(([key,label]) => ["--label",`${label}=${key === "kind" ? "managed-profile-claim" : key === "schema" ? "1" : this.identity[key as keyof OperationIdentity]}`]),"--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",this.image,"/bin/false"],options);
        ensure(typeof id === "string" && idPattern.test(id),"operation_lease_id_invalid");
        const evidence=await this.inspect(id,options); active(options); assertOperationLeaseEvidence(evidence,this.identity,id);
        this.leaseId=id; this.uncertain=false; return this.snapshot()!;
      } catch (error) {
        // Caller abort must not cancel reconciliation of an already dispatched create.
        try { await this.reconcile({signal:AbortSignal.timeout(30_000)}); }
        catch {
          // Neither foreign evidence nor a nonzero client exit proves this
          // dispatched daemon create has settled. Windows termination can
          // report a numeric exit without signal metadata. Retain uncertainty.
          throw new Error("operation_lease_claim_unconfirmed");
        }
        throw error;
      }
    } finally { this.busy=false; }
  }
  private async reconcile(options: LeaseOptions) {
    let evidence: unknown;
    try { evidence=await this.inspect(this.name,options); }
    catch { throw new Error("operation_lease_claim_uncertain"); }
    try { assertOperationLeaseEvidence(evidence,this.identity); }
    catch { throw new Error("operation_lease_profile_busy"); }
    active(options); this.leaseId=evidence.id; this.uncertain=false; return this.snapshot()!;
  }
  async release(options: LeaseOptions = {}) {
    active(options); ensure(!this.busy,"operation_lease_busy"); this.busy=true;
    try {
      ensure(this.leaseId,"operation_lease_required");
      const id=this.leaseId;
      // Retry a cancelled exact-ID removal only after confirming its absence.
      const listed=await this.invoke(["container","ls","--all","--no-trunc","--filter",`id=${id}`,"--format","{{.ID}}"],options); active(options);
      if (listed.split(/\r?\n/).includes(id)) {
        await this.verify(options); active(options);
        await this.invoke(["rm",id],options); active(options);
        const remaining=await this.invoke(["container","ls","--all","--no-trunc","--filter",`id=${id}`,"--format","{{.ID}}"],options); active(options);
        ensure(!remaining.split(/\r?\n/).includes(id),"operation_lease_release_unconfirmed");
      }
      this.leaseId=undefined;
    } finally { this.busy=false; }
  }
  /** Manual recovery uses an explicit receipt, never normal acquire/adoption. */
  static async inspectReceipt(identity: OperationLeaseIdentity, image: string, invoke: LeaseCommand = defaultCommand, options: LeaseOptions = {}) {
    ensure(typeof identity.lease_id === "string" && idPattern.test(identity.lease_id),"operation_lease_id_invalid");
    const lease=new DockerOperationLease(identity,image,invoke); lease.leaseId=identity.lease_id; await lease.verify(options); return lease;
  }
}
