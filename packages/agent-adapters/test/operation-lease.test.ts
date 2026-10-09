import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DockerOperationLease, assertOperationLeaseEvidence, type OperationIdentity, type LeaseCommand } from "../src/operation-lease.ts";
import { DockerCommandError } from "../src/task-runtime.ts";

const image=`node:22@sha256:${"a".repeat(64)}`, id="b".repeat(64);
const identity=():OperationIdentity => ({owner:randomUUID(),provider:"codex",operation:randomUUID()});
function evidence(owner:OperationIdentity, changes:Record<string,unknown> = {}) {
  return {id,name:`/cg-managed-lease-${owner.owner}`,...owner,kind:"managed-profile-claim",schema:"1",running:false,status:"created",network:"none",readonly:true,mounts:0,ports:0,...changes};
}
function fixture(owner=identity()) {
  let present=false;
  const commands:string[][]=[];
  const invoke:LeaseCommand=async args => {
    commands.push(args);
    if(args[0] === "create") { assert.equal(present,false); present=true; return id; }
    if(args[0] === "inspect") { assert.equal(present,true); return JSON.stringify(evidence(owner)); }
    if(args[0] === "rm") { assert.deepEqual(args,["rm",id]); present=false; return id; }
    if(args.includes(`id=${id}`)) return present ? id : "";
    if(args[0] === "container") return present ? `cg-managed-lease-${owner.owner}` : "";
    throw Error("fixture_unexpected_command");
  };
  return {owner,commands,invoke,present:()=>present,lease:new DockerOperationLease(owner,image,invoke)};
}
test("durable claim is never started, private and idempotent; exact immutable ID releases last",async () => {
  const f=fixture(); const first=await f.lease.acquire();
  assert.deepEqual(await f.lease.acquire(),first);
  assert.equal(f.commands.filter(args => args[0] === "create").length,1);
  const create=f.commands.find(args => args[0] === "create")!;
  assert.ok(create.includes("--read-only") && create.includes("none"));
  assert.ok(!create.some(arg => ["start","run","--mount","--volume","--publish","--env"].includes(arg)));
  assert.deepEqual(f.lease.snapshot(),{...f.owner,lease_id:id});
  await f.lease.release(); assert.equal(f.lease.snapshot(),undefined); assert.equal(f.present(),false);
  assert.deepEqual(f.commands.find(args => args[0] === "rm"),["rm",id]);
});
test("an incumbent name excludes a contender before any create or remove",async () => {
  const owner=identity(), commands:string[][]=[];
  const lease=new DockerOperationLease(owner,image,async args => { commands.push(args); return `cg-managed-lease-${owner.owner}`; });
  await assert.rejects(lease.acquire(),/^Error: operation_lease_profile_busy$/);
  assert.equal(commands.length,1); assert.equal(lease.isUncertain(),false);
  assert.equal(lease.snapshot(),undefined);
});
test("uncertain create reconciles only its own evidence and never redispatches while absent",async () => {
  const owner=identity(), commands:string[][]=[]; let late=false;
  const lease=new DockerOperationLease(owner,image,async args => {
    commands.push(args);
    if(args[0] === "create") throw new DockerCommandError("timeout");
    if(args[0] === "inspect") { if(late) return JSON.stringify(evidence(owner)); throw Error("missing"); }
    return "";
  });
  await assert.rejects(lease.acquire(),/^Error: operation_lease_claim_unconfirmed$/);
  await assert.rejects(lease.acquire(),/^Error: operation_lease_claim_uncertain$/);
  await assert.rejects(lease.release(),/^Error: operation_lease_required$/);
  assert.equal(lease.isUncertain(),true); assert.equal(commands.filter(args => args[0] === "create").length,1);
  late=true; assert.deepEqual(await lease.acquire(),{...owner,lease_id:id});
  assert.equal(lease.isUncertain(),false);
});
test("foreign evidence after ambiguous dispatch does not certify its pending create resolved",async () => {
  for(const reason of ["cancelled","failed"] as const) {
    const owner=identity(); const lease=new DockerOperationLease(owner,image,async args => {
      if(args[0] === "create") throw new DockerCommandError(reason);
      if(args[0] === "inspect") return JSON.stringify(evidence({...owner,operation:randomUUID()}));
      return "";
    });
    await assert.rejects(lease.acquire(),/^Error: operation_lease_claim_unconfirmed$/);
    assert.equal(lease.isUncertain(),true); assert.equal(lease.snapshot(),undefined);
  }
});
test("parallel first claim is exclusive even when both contenders observe initial absence",async () => {
  const first=identity(), second={...first,operation:randomUUID()}; let holder:OperationIdentity|undefined;
  let arrivals=0, unblock!:()=>void;
  const barrier=new Promise<void>(resolve => {unblock=resolve;});
  const commands:string[][]=[];
  const command=(owner:OperationIdentity):LeaseCommand => async args => {
    commands.push(args);
    if(args[0] === "container" && args.some(arg => arg.startsWith("name="))) {
      arrivals++; if(arrivals===2) unblock(); await barrier; return "";
    }
    if(args[0] === "create") { if(holder) throw new Error("docker_failed"); holder=owner; return id; }
    if(args[0] === "inspect") { if(!holder) throw Error("fixture_missing"); return JSON.stringify(evidence(holder)); }
    if(args[0] === "rm") { holder=undefined; return id; }
    return holder ? id : "";
  };
  const leases=[new DockerOperationLease(first,image,command(first)),new DockerOperationLease(second,image,command(second))];
  const results=await Promise.allSettled(leases.map(lease => lease.acquire()));
  assert.equal(results.filter(result => result.status === "fulfilled").length,1);
  const rejected=results.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.message,"operation_lease_claim_unconfirmed");
  const loser=leases[results.findIndex(result => result.status === "rejected")];
  assert.equal(loser.snapshot(),undefined); assert.equal(loser.isUncertain(),true);
  await assert.rejects(loser.release(),/^Error: operation_lease_required$/);
  assert.ok(!commands.some(args => args[0] === "rm"));
  const winner=leases[results.findIndex(result => result.status === "fulfilled")];
  assert.deepEqual(await winner.verify(),winner.snapshot());
  await winner.release();
  await assert.rejects(loser.acquire(),/^Error: operation_lease_claim_uncertain$/);
  assert.equal(loser.isUncertain(),true);
  assert.equal(commands.filter(args => args[0] === "create").length,2,"the uncertain loser cannot redispatch");
});
test("nonzero exit with foreign evidence retains a delayed daemon create until its own immutable evidence appears",async () => {
  const owner=identity(), foreign={...owner,operation:randomUUID()}, foreignId="c".repeat(64);
  let holder:OperationIdentity|undefined, holderId:string|undefined;
  const commands:string[][]=[];
  const lease=new DockerOperationLease(owner,image,async args => {
    commands.push(args);
    if(args[0] === "create") { holder=foreign; holderId=foreignId; throw new Error("docker_failed"); }
    if(args[0] === "inspect") { if(!holder) throw Error("missing"); return JSON.stringify(evidence(holder,{id:holderId})); }
    if(args[0] === "rm") { assert.deepEqual(args,["rm",id]); holder=undefined; holderId=undefined; return id; }
    return holderId ?? "";
  });
  await assert.rejects(lease.acquire(),/^Error: operation_lease_claim_unconfirmed$/);
  await assert.rejects(lease.acquire(),/^Error: operation_lease_profile_busy$/);
  await assert.rejects(lease.release(),/^Error: operation_lease_required$/);
  assert.equal(holder,foreign); assert.equal(holderId,foreignId); assert.equal(lease.isUncertain(),true);
  assert.ok(!commands.some(args => args[0] === "rm"));
  holder=undefined; holderId=undefined; // Explicit fixture event: foreign owner releases.
  await assert.rejects(lease.acquire(),/^Error: operation_lease_claim_uncertain$/);
  assert.equal(lease.isUncertain(),true);
  holder=owner; holderId=id; // The already dispatched daemon create completes later.
  assert.deepEqual(await lease.acquire(),{...owner,lease_id:id});
  assert.equal(lease.isUncertain(),false);
  assert.equal(commands.filter(args => args[0] === "create").length,1);
  await lease.release(); assert.equal(holder,undefined); assert.equal(lease.snapshot(),undefined);
});
test("cancelled own create captures immutable evidence for later cleanup but preserves cancellation",async () => {
  const owner=identity(), controller=new AbortController(); let dispatched=false;
  const lease=new DockerOperationLease(owner,image,async (args,options) => {
    if(args[0] === "create") { dispatched=true; controller.abort(); throw new DockerCommandError("cancelled"); }
    if(args[0] === "inspect") { assert.notEqual(options.signal,controller.signal); return JSON.stringify(evidence(owner)); }
    return "";
  });
  await assert.rejects(lease.acquire({signal:controller.signal}),/docker_cancelled/);
  assert.equal(dispatched,true); assert.deepEqual(lease.snapshot(),{...owner,lease_id:id});
});
test("changed lease ID or unsafe config refuses removal without exposing untrusted evidence",async () => {
  const owner=identity(), secret="SYNTHETIC_PRIVATE_LABEL_VALUE";
  for(const changes of [{id:"c".repeat(64)},{owner:secret},{running:true},{status:"exited"},{network:"bridge"},{readonly:false},{mounts:1},{ports:1},{schema:"2"},{kind:secret},{env:secret}]) {
    let removals=0, substituted=false;
    const lease=await DockerOperationLease.inspectReceipt({...owner,lease_id:id},image,async args => {
      if(args[0] === "rm") removals++;
      return args[0] === "inspect" ? JSON.stringify(evidence(owner,substituted ? changes : {})) : id;
    });
    substituted=true;
    await assert.rejects(lease.release(),error => error instanceof Error && error.name === "Error" && !error.message.includes(secret));
    assert.equal(removals,0); assert.ok(lease.snapshot());
  }
});
test("lease identity, image and evidence validate before commands; snapshots are narrow copies",async () => {
  const owner=identity(); let calls=0; const invoke:LeaseCommand=async () => {calls++;return "";};
  for(const changed of [{owner:"bad"},{operation:"pid-1"},{provider:"../codex"},{provider:{toString:()=>"codex"}}]) assert.throws(() => new DockerOperationLease({...owner,...changed} as OperationIdentity,image,invoke),/^Error: operation_lease_identity_invalid$/);
  assert.throws(() => new DockerOperationLease(owner,"node:latest",invoke),/^Error: operation_lease_image_invalid$/);
  assert.throws(() => assertOperationLeaseEvidence({...evidence(owner),unknown:"sensitive"},owner),/^Error: operation_lease_evidence_invalid$/);
  assert.equal(calls,0);
  const f=fixture(); await f.lease.acquire(); const snapshot=f.lease.snapshot()!; snapshot.owner=randomUUID(); assert.equal(f.lease.snapshot()!.owner,f.owner.owner);
  const controller=new AbortController(); controller.abort();
  const before=f.commands.length; await assert.rejects(f.lease.acquire({signal:controller.signal}),/docker_cancelled/); assert.equal(f.commands.length,before);
});
test("malformed inspect JSON exposes a fixed error without its raw text",async () => {
  const owner=identity();
  await assert.rejects(DockerOperationLease.inspectReceipt({...owner,lease_id:id},image,async () => "SYNTHETIC_PRIVATE_INVALID_JSON"),/^Error: operation_lease_evidence_invalid$/);
});
test("release does not certify cleanup if exact ID remains or cancellation interrupts confirmation",async () => {
  const owner=identity(); let remove=false;
  const lease=await DockerOperationLease.inspectReceipt({...owner,lease_id:id},image,async args => {
    if(args[0] === "inspect") return JSON.stringify(evidence(owner));
    if(args[0] === "rm") remove=true;
    return id;
  });
  await assert.rejects(lease.release(),/^Error: operation_lease_release_unconfirmed$/); assert.equal(remove,true); assert.ok(lease.snapshot());
  const controller=new AbortController(); let present=true;
  const cancelled=await DockerOperationLease.inspectReceipt({...owner,lease_id:id},image,async args => {
    if(args[0] === "inspect") return JSON.stringify(evidence(owner));
    if(args[0] === "rm") { present=false; controller.abort(); return id; }
    return present ? id : "";
  });
  await assert.rejects(cancelled.release({signal:controller.signal}),/docker_cancelled/); assert.ok(cancelled.snapshot());
  await cancelled.release(); assert.equal(cancelled.snapshot(),undefined);
});
