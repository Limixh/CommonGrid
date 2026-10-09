import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { DockerCommandError } from "../../packages/agent-adapters/src/task-runtime.ts";
import { ManagedCliRuntime, assertManagedContainerFence, removeManagedContainer, removeManagedOperationContainer, type ManagedContainerEvidence } from "./managed-runtime.mts";
import { assertManagedProfileTrust, validateManagedHostTrust, installManagedHostTrustScript, verifyManagedHostTrustScript } from "./managed-trust.mts";

const owner = randomUUID(), operation = randomUUID(), id = "a".repeat(64);
const evidence = (changes: Partial<ManagedContainerEvidence> = {}): ManagedContainerEvidence => ({id,owner,operation,running:false,status:"exited",...changes});
const fixtureLeaseId = "c".repeat(64);
function installLeaseFixture(runtime: ManagedCliRuntime, invoke: (args:string[], options:{signal?:AbortSignal}) => Promise<string>) {
  let present = false;
  const leaseCommands: string[][] = [], allCommands: string[][] = [];
  const leaseName = `cg-managed-lease-${runtime.owner}`;
  const leaseEvidence = () => JSON.stringify({id:fixtureLeaseId,name:`/${leaseName}`,owner:runtime.owner,provider:runtime.provider,operation:runtime.operationIdentity().operation,kind:"managed-profile-claim",schema:"1",running:false,status:"created",network:"none",readonly:true,mounts:0,ports:0});
  (runtime as any).command = async (args:string[], options:{signal?:AbortSignal} = {}) => {
    allCommands.push(args);
    if (args[0] === "create" && args.includes(leaseName)) { leaseCommands.push(args); present = true; return fixtureLeaseId; }
    if (args[0] === "inspect" && [fixtureLeaseId,leaseName].includes(args.at(-1)!)) { leaseCommands.push(args); assert.ok(present,"fixture_lease_absent"); return leaseEvidence(); }
    if (args.includes(`name=^/${leaseName}$`)) { leaseCommands.push(args); return present ? leaseName : ""; }
    if (args.includes(`id=${fixtureLeaseId}`)) { leaseCommands.push(args); return present ? fixtureLeaseId : ""; }
    if (args[0] === "rm" && args.at(-1) === fixtureLeaseId) { leaseCommands.push(args); present = false; return ""; }
    return invoke(args,options);
  };
  return {leaseCommands,allCommands,present:()=>present,removeExternally:()=>{present=false;}};
}
test("same profile restoration generates a distinct operation fence", () => {
  const first=ManagedCliRuntime.restore({owner,provider:"codex"}), second=ManagedCliRuntime.restore(first.identity());
  assert.deepEqual(first.identity(),second.identity()); assert.notEqual(first.operationIdentity().operation,second.operationIdentity().operation); assert.equal(first.container,second.container);
});
test("invalid ownership evidence and mismatched owner/operation never reach removal", async () => {
  for(const value of [null,{},evidence({id:"mutable-name"}),evidence({owner:randomUUID()}),evidence({operation:randomUUID()}),{...evidence(),env:{secret:"synthetic"}},evidence({running:"false" as any})]) {
    let calls=0; await assert.rejects(()=>removeManagedContainer(value,owner,operation,false,async()=>{calls++;return "";})); assert.equal(calls,0);
  }
});
test("reference recovery rejects running, paused, restarting and removal states", async () => {
  for(const value of [evidence({running:true,status:"running"}),evidence({running:false,status:"restarting"}),evidence({running:false,status:"paused"}),evidence({running:false,status:"removing"})]) {
    let calls=0; await assert.rejects(()=>removeManagedContainer(value,owner,operation,true,async()=>{calls++;return "";})); assert.equal(calls,0);
  }
});
test("reference recovery targets the verified immutable ID and never forces or touches volumes", async () => {
  const commands:string[][]=[]; await removeManagedContainer(evidence(),owner,operation,true,async args=>{commands.push(args);return "";});
  assert.deepEqual(commands[0],["rm",id]); assert.ok(commands[1].includes(`id=${id}`)); assert.ok(commands.every(args=>!args.includes("volume")&&!args.includes("--force")&&!args.includes("prune")));
});
test("stopped-to-running race is rejected by non-forced Docker removal", async () => {
  const commands:string[][]=[]; await assert.rejects(()=>removeManagedContainer(evidence(),owner,operation,true,async args=>{commands.push(args);throw new Error("managed_docker_failed");}));
  assert.deepEqual(commands,[["rm",id]]);
});
test("normal cleanup targets the inspected ID despite mutable name replacement", async () => {
  const commands:string[][]=[]; await removeManagedContainer(evidence({running:true,status:"running"}),owner,operation,false,async args=>{commands.push(args);return "";});
  assert.deepEqual(commands[0],["rm","--force",id]); assert.ok(commands[1].includes(`id=${id}`));
});
test("cleanup cannot be reported confirmed while the removed ID remains listed", async () => {
  let calls=0; await assert.rejects(()=>removeManagedContainer(evidence(),owner,operation,true,async()=>++calls===1?"":id),/managed_cleanup_unconfirmed/); assert.equal(calls,2);
});
test("recovery operation must be an explicit valid identity and state proof", () => {
  assert.throws(()=>assertManagedContainerFence(evidence(),owner,"pid-123",true));
  assert.throws(()=>assertManagedContainerFence(evidence(),owner,undefined,true), /managed_recovery_operation_required/);
  assert.doesNotThrow(()=>assertManagedContainerFence(evidence({status:"created"}),owner,operation,true));
  assert.doesNotThrow(()=>assertManagedContainerFence(evidence({status:"dead"}),owner,operation,true));
});

test("interrupted exec cleanup removes only its captured immutable ID", async () => {
  const commands: string[][] = [];
  await removeManagedOperationContainer(id, owner, operation, async args => {
    commands.push(args);
    if (args[0] === "inspect") return JSON.stringify(evidence({running:true,status:"running"}));
    return commands.length === 1 ? id : "";
  });
  assert.equal(commands.length, 4);
  assert.equal(commands[1].at(-1), id);
  assert.deepEqual(commands[2], ["rm", "--force", id]);
  assert.ok(commands.every(args => !args.some(arg => arg.startsWith("name=") || arg.startsWith("cg-managed-"))));
});

test("a replacement survives old exec cleanup when its captured ID is absent", async () => {
  const replacementId = "b".repeat(64), commands: string[][] = [];
  await removeManagedOperationContainer(id, owner, operation, async args => { commands.push(args); return replacementId; });
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes(`id=${id}`));
});

test("captured-ID cleanup rejects substituted ID and foreign operation before deletion", async () => {
  for (const value of [evidence({id:"b".repeat(64)}), evidence({operation:randomUUID()}), evidence({owner:randomUUID()})]) {
    const commands: string[][] = [];
    await assert.rejects(() => removeManagedOperationContainer(id, owner, operation, async args => { commands.push(args); return args[0] === "inspect" ? JSON.stringify(value) : id; }));
    assert.equal(commands.length, 2);
    assert.ok(!commands.some(args => args[0] === "rm"));
  }
});

test("captured-ID cleanup validates identities before any command", async () => {
  for (const identities of [["mutable-name", owner, operation], [id, "wrong-owner", operation], [id, owner, "wrong-operation"]]) {
    let calls = 0;
    await assert.rejects(() => removeManagedOperationContainer(identities[0], identities[1], identities[2], async () => { calls++; return ""; }));
    assert.equal(calls, 0);
  }
});

test("pre-aborted start, stop and exec do not dispatch a command", async () => {
  const runtime = ManagedCliRuntime.restore({owner, provider:"codex"}), cancellation = new AbortController();
  let calls = 0;
  (runtime as any).command = async () => { calls++; throw new Error("unexpected_dispatch"); };
  cancellation.abort();
  await assert.rejects(() => runtime.beginOperation({signal:cancellation.signal}), /docker_cancelled/);
  await assert.rejects(() => runtime.finishOperation({signal:cancellation.signal}), /docker_cancelled/);
  await assert.rejects(() => runtime.start({signal:cancellation.signal}), /docker_cancelled/);
  await assert.rejects(() => runtime.stop(false, {signal:cancellation.signal}), /docker_cancelled/);
  await assert.rejects(() => runtime.exec(["node", "-e", ""], 1000, {signal:cancellation.signal}), /docker_cancelled/);
  assert.equal(calls, 0);
});

test("cancelled create reconciles owned ID with a fresh signal and retains volumes", async () => {
  const runtime = ManagedCliRuntime.restore({owner, provider:"codex"}), cancellation = new AbortController();
  let exists = false;
  const commands: string[][] = [], cleanupSignals: AbortSignal[] = [];
  installLeaseFixture(runtime, async (args: string[], options: {signal?:AbortSignal}) => {
    commands.push(args);
    if (args[0] === "volume") return owner;
    if (args[0] === "create") { exists = true; cancellation.abort(); throw new DockerCommandError("cancelled"); }
    if (cancellation.signal.aborted) { assert.ok(options.signal && options.signal !== cancellation.signal && !options.signal.aborted); cleanupSignals.push(options.signal); }
    if (args[0] === "inspect") return JSON.stringify(evidence({operation:runtime.operationIdentity().operation,status:"created"}));
    if (args[0] === "rm") { assert.deepEqual(args,["rm","--force",id]); exists = false; return ""; }
    if (args.includes(`name=^/${runtime.container}$`)) return exists ? runtime.container : "";
    return "";
  });
  await assert.rejects(() => runtime.start({signal:cancellation.signal}), /docker_cancelled/);
  assert.equal(exists, false); assert.ok(cleanupSignals.length > 0);
  assert.ok(commands.some(args => args[0] === "rm"));
  assert.ok(!commands.some(args => args[0] === "volume" && args[1] === "rm"));
  await runtime.stop(false, {signal:new AbortController().signal});
});

test("lost create ID stays unconfirmed while absent, then resolves only on owned evidence", async () => {
  const runtime = ManagedCliRuntime.restore({owner, provider:"codex"}), cancellation = new AbortController();
  let lateCreate = false;
  const removed: string[][] = [];
  installLeaseFixture(runtime, async (args: string[]) => {
    if (args[0] === "volume") return owner;
    if (args[0] === "create") { cancellation.abort(); throw new DockerCommandError("cancelled"); }
    if (args[0] === "inspect") return JSON.stringify(evidence({operation:runtime.operationIdentity().operation,status:"created"}));
    if (args[0] === "rm") { removed.push(args); lateCreate = false; return ""; }
    return args.includes(`name=^/${runtime.container}$`) && lateCreate ? runtime.container : "";
  });
  await assert.rejects(() => runtime.start({signal:cancellation.signal}), /managed_start_cleanup_unconfirmed/);
  await assert.rejects(() => runtime.stop(), /managed_cleanup_unconfirmed/);
  await assert.rejects(() => runtime.start(), /managed_cleanup_unconfirmed/);
  assert.ok(runtime.leaseIdentity(), "uncertain namespace create must retain its durable claim");
  await assert.rejects(() => runtime.finishOperation(), /managed_cleanup_unconfirmed/);
  assert.equal(removed.length, 0);
  lateCreate = true; await runtime.stop();
  assert.deepEqual(removed, [["rm","--force",id]]);
  await runtime.finishOperation();
});

test("stop cancellation after removal cannot report confirmed cleanup", async () => {
  const cancellation = new AbortController(), commands: string[][] = [];
  await assert.rejects(() => removeManagedContainer(evidence(), owner, operation, false, async args => {
    commands.push(args); cancellation.abort(); return "";
  }, {signal:cancellation.signal}), /docker_cancelled/);
  assert.deepEqual(commands, [["rm", "--force", id]]);
});

test("start refuses an existing same-operation namespace without cleanup", async () => {
  const runtime = ManagedCliRuntime.restore({owner,provider:"codex"}), commands: string[][] = [];
  installLeaseFixture(runtime, async (args: string[]) => { commands.push(args); return args[0] === "volume" ? owner : runtime.container; });
  await assert.rejects(() => runtime.start(), /managed_profile_busy/);
  assert.ok(!commands.some(args => args[0] === "create" || args[0] === "rm"));
});

const trustNow = Date.now();
const publicRoot = rootCertificates.find(pem => {
  const certificate = new X509Certificate(pem);
  return certificate.ca && certificate.subject === certificate.issuer && certificate.verify(certificate.publicKey) && Date.parse(certificate.validFrom) <= trustNow && Date.parse(certificate.validTo) > trustNow;
})! + "\n";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const trustProof = {
  windows_tls_verified:true, installed_root:true, private_key_exported:false,
  purpose:"managed_claude_optional_public_root", endpoint:"api.anthropic.com:443", source:"operator_verified_tls_chain_and_installed_root",
  checked_at:new Date(trustNow).toISOString(), certificate_sha256:sha256(new X509Certificate(publicRoot).raw), pem_sha256:sha256(publicRoot),
};
const selectedTrust = () => validateManagedHostTrust(publicRoot, trustProof, owner, trustNow).trust;

test("optional root requires scoped purpose, verified endpoint, source, current proof and exact public bytes", () => {
  assert.equal(selectedTrust().profile_owner, owner);
  for (const change of [
    {purpose:"product_default"}, {endpoint:"example.com:443"}, {source:"antivirus_workaround"},
    {checked_at:"invalid"}, {checked_at:"2026-02-31T12:00:00Z"}, {checked_at:new Date(trustNow + 1).toISOString()}, {checked_at:new Date(trustNow - 31 * 86400_000).toISOString()},
    {windows_tls_verified:false}, {installed_root:false}, {private_key_exported:true},
    {pem_sha256:undefined}, {pem_sha256:"0".repeat(64)}, {certificate_sha256:"0".repeat(64)},
  ]) assert.throws(() => validateManagedHostTrust(publicRoot, {...trustProof,...change}, owner, trustNow), /managed_host_trust_invalid/);
  for (const value of [publicRoot + publicRoot, publicRoot + "PRIVATE KEY", publicRoot.replace(/\n/g,"\r\n")]) {
    assert.throws(() => validateManagedHostTrust(value, trustProof, owner, trustNow), /managed_host_trust_invalid/);
  }
});

test("trust selection is bound to one Claude profile and snapshots cannot mutate runtime selection", () => {
  const trust = selectedTrust(), runtime = ManagedCliRuntime.restore({owner,provider:"claude",trust});
  trust.pem_sha256 = "0".repeat(64);
  const identity = runtime.identity(); identity.trust!.pem_sha256 = "1".repeat(64);
  assert.equal(runtime.identity().trust!.pem_sha256, trustProof.pem_sha256);
  assert.throws(() => ManagedCliRuntime.restore({owner:randomUUID(),provider:"claude",trust:selectedTrust()}), /managed_profile_trust_owner_mismatch/);
  assert.throws(() => ManagedCliRuntime.restore({owner,provider:"codex",trust:selectedTrust()}), /managed_profile_trust_provider_invalid/);
  assert.throws(() => ManagedCliRuntime.restore({owner,provider:"claude",trust:{...selectedTrust(),kind:"bundled" as any}}), /managed_profile_trust_invalid/);
  assert.equal(ManagedCliRuntime.restore({owner,provider:"claude"}).identity().trust, undefined);
});

test("malformed saved trust exposes fixed codes without raw metadata or AssertionError payloads", () => {
  const supplied = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_PRINT";
  const changes: Array<[Record<string,unknown>,string]> = [
    [{schema_version:supplied},"managed_profile_trust_invalid"], [{kind:supplied},"managed_profile_trust_invalid"],
    [{profile_owner:supplied},"managed_profile_trust_owner_mismatch"], [{purpose:supplied},"managed_profile_trust_purpose_invalid"],
    [{endpoint:`https://${supplied}/?token=${supplied}`},"managed_profile_trust_endpoint_invalid"], [{source:supplied},"managed_profile_trust_source_invalid"],
    [{checked_at:supplied},"managed_profile_trust_date_invalid"], [{certificate_sha256:supplied},"managed_profile_trust_hash_invalid"],
    [{pem_sha256:{secret:supplied}},"managed_profile_trust_hash_invalid"], [{[supplied]:supplied},"managed_profile_trust_invalid"],
  ];
  const onlyCode = (expected:string) => (error:unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name,"Error"); assert.equal(error.message,expected);
    assert.ok(!(error instanceof assert.AssertionError));
    assert.ok(!["actual","expected","cause","operator"].some(key => Object.hasOwn(error,key)));
    assert.ok(!`${error.stack}\n${JSON.stringify(error)}`.includes(supplied));
    return true;
  };
  for (const [change,code] of changes) {
    const trust = {...selectedTrust(),...change};
    assert.throws(() => assertManagedProfileTrust(trust,owner,"claude"),onlyCode(code));
    assert.throws(() => ManagedCliRuntime.restore({owner,provider:"claude",trust:trust as any}),onlyCode(code));
  }
  assert.throws(() => assertManagedProfileTrust({secret:supplied},owner,supplied),onlyCode("managed_profile_trust_provider_invalid"));
  assert.throws(() => assertManagedProfileTrust([supplied],owner,"claude"),onlyCode("managed_profile_trust_invalid"));
});

function trustFixtureScripts() {
  const files = new Map<string,string>(), output: unknown[] = [];
  const fs = {
    existsSync:(file:string) => files.has(file),
    readFileSync:(file:string) => { if (!files.has(file)) throw Error("fixture_missing"); return files.get(file)!; },
    writeFileSync:(file:string,value:string) => { if (files.has(file)) throw Error("fixture_exists"); files.set(file,value); },
    chmodSync:() => {},
  };
  const evaluate = (script:string, values:string[]) => runInNewContext(script, {
    require:(name:string) => name === "node:fs" ? fs : name === "node:tls" ? {rootCertificates:["fixture-bundled-root"]} : {createHash,X509Certificate},
    process:{argv:["node",...values]}, console:{log:(value:unknown) => output.push(value)},
  });
  return {files,output,evaluate};
}

test("fixture-only immutable bundle installation and startup verify pinned root, manifest and bundled roots", () => {
  const fixture = trustFixtureScripts(), manifest = JSON.stringify(selectedTrust());
  fixture.evaluate(installManagedHostTrustScript,[publicRoot,manifest]);
  const original = [...fixture.files];
  fixture.evaluate(installManagedHostTrustScript,[publicRoot,manifest]);
  assert.deepEqual([...fixture.files], original);
  fixture.evaluate(verifyManagedHostTrustScript,[manifest]); assert.equal(fixture.output.at(-1), true);
  for (const [file] of original) {
    const value = fixture.files.get(file)!;
    fixture.files.set(file,value + "tampered");
    assert.throws(() => fixture.evaluate(installManagedHostTrustScript,[publicRoot,manifest]), /profile_trust_mismatch/);
    fixture.evaluate(verifyManagedHostTrustScript,[manifest]); assert.equal(fixture.output.at(-1), false);
    fixture.files.set(file,value);
  }
  const foreign = JSON.stringify({...selectedTrust(),profile_owner:randomUUID()});
  fixture.evaluate(verifyManagedHostTrustScript,[foreign]); assert.equal(fixture.output.at(-1), false);
});

async function fakeStartedRuntime(trust = undefined as ReturnType<typeof selectedTrust> | undefined, validTrust = true) {
  const runtime = ManagedCliRuntime.restore({owner,provider:"claude",...(trust ? {trust} : {})}), commands:string[][]=[];
  const pins = JSON.parse(await readFile(new URL("binaries.lock.json",import.meta.url),"utf8"));
  const bridges = new Map(await Promise.all(["runtime-bridge.mjs","tunnel-wire.mjs","mcp.mjs","task-broker.mjs"].map(async file => [file,sha256(await readFile(new URL(file,import.meta.url)))] as const)));
  let exists = false;
  const leaseFixture = installLeaseFixture(runtime, async (args:string[]) => {
    commands.push(args);
    if (args[0] === "volume") return owner;
    if (args[0] === "create") { exists = true; return id; }
    if (args[0] === "inspect") return JSON.stringify(evidence({operation:runtime.operationIdentity().operation,running:true,status:"running"}));
    if (args[0] === "rm") { exists = false; return ""; }
    if (args.includes(`id=${id}`)) return exists ? id : "";
    if (args.includes(`name=^/${runtime.container}$`)) return exists ? runtime.container : "";
    if (args[0] === "exec") {
      const script = args[4];
      if (script === verifyManagedHostTrustScript) return String(validTrust);
      for (const [file,hash] of bridges) if (script.includes(`/opt/cg/${file}`)) return hash;
      if (script.includes("/opt/cg/claude'")) return pins.claude.sha256;
      return "true";
    }
    return "";
  });
  return {runtime,commands,leaseFixture};
}

test("lease is acquired before namespace mutation, held through restart, and released last", async () => {
  const {runtime,leaseFixture} = await fakeStartedRuntime();
  await runtime.beginOperation(); const receipt = runtime.leaseIdentity(); assert.ok(receipt);
  await runtime.beginOperation(); await runtime.start();
  const createLease = leaseFixture.allCommands.findIndex(args => args[0] === "create" && args.includes(`cg-managed-lease-${owner}`));
  const createNamespace = leaseFixture.allCommands.findIndex(args => args[0] === "create" && args.includes(runtime.container));
  assert.ok(createLease >= 0 && createLease < createNamespace);
  await runtime.stop(); assert.deepEqual(runtime.leaseIdentity(),receipt); assert.equal(leaseFixture.present(),true);
  await runtime.start(); assert.deepEqual(runtime.leaseIdentity(),receipt);
  assert.equal(leaseFixture.leaseCommands.filter(args => args[0] === "create").length,1);
  await runtime.finishOperation(); assert.equal(leaseFixture.present(),false);
  const removals = leaseFixture.allCommands.filter(args => args[0] === "rm");
  assert.deepEqual(removals.at(-1),["rm",fixtureLeaseId]);
  assert.ok(removals.slice(0,-1).some(args => args.at(-1) === id));
  await assert.rejects(() => runtime.start(),/managed_operation_finished/);
});

test("an uncertain lease create cannot mutate a profile or release on one absent snapshot", async () => {
  const runtime = ManagedCliRuntime.restore({owner,provider:"codex"});
  const commands: string[][] = [];
  (runtime as any).command = async (args:string[]) => {
    commands.push(args);
    if (args[0] === "create") throw new DockerCommandError("cancelled");
    if (args.includes(`name=^/cg-managed-lease-${owner}$`)) return "";
    throw new Error("fixture_missing");
  };
  await assert.rejects(() => runtime.beginOperation());
  await assert.rejects(() => runtime.beginOperation());
  await assert.rejects(() => runtime.finishOperation());
  assert.equal(commands.filter(args => args[0] === "create").length,1);
  assert.ok(!commands.some(args => ["run","start","exec","rm","volume"].includes(args[0])));
});

test("losing a lease while its captured namespace exists cannot confirm cleanup or mutate it", async () => {
  const {runtime,leaseFixture} = await fakeStartedRuntime(); await runtime.start();
  const receipt = runtime.leaseIdentity(); assert.ok(receipt);
  leaseFixture.removeExternally(); const before = leaseFixture.allCommands.length;
  await assert.rejects(() => runtime.stop(),/managed_cleanup_unconfirmed/);
  await assert.rejects(() => runtime.finishOperation(),/managed_cleanup_unconfirmed/);
  assert.deepEqual(runtime.leaseIdentity(),receipt);
  assert.ok(!leaseFixture.allCommands.slice(before).some(args => ["rm","start","exec","volume"].includes(args[0])));
});

test("an installer that loses its create ID keeps the claim despite absent init listings", async () => {
  const runtime = ManagedCliRuntime.restore({owner,provider:"claude"});
  const leaseFixture = installLeaseFixture(runtime, async args => {
    if (args[0] === "volume") return owner;
    if (args[0] === "create") throw new DockerCommandError("cancelled");
    return "";
  });
  await assert.rejects(() => runtime.installTrustBundle(),/managed_cleanup_unconfirmed/);
  assert.ok(runtime.leaseIdentity()); assert.equal(leaseFixture.present(),true);
  await assert.rejects(() => runtime.finishOperation(),/managed_cleanup_unconfirmed/);
  assert.ok(!leaseFixture.allCommands.some(args => args[0] === "rm" || (args[0] === "volume" && args[1] === "rm")));
});

test("an incumbent lease blocks installer and destroy without dispatching mutations", async () => {
  for (const action of ["install","destroy"] as const) {
    const runtime = ManagedCliRuntime.restore({owner,provider:"claude"}), commands:string[][]=[];
    (runtime as any).command = async (args:string[]) => {
      commands.push(args);
      if (args[0] === "create") throw new DockerCommandError("failed");
      if (args.includes(`name=^/cg-managed-lease-${owner}$`)) return `cg-managed-lease-${owner}`;
      if (args[0] === "inspect") return JSON.stringify({id:fixtureLeaseId,name:`/cg-managed-lease-${owner}`,owner,provider:"claude",operation:randomUUID(),kind:"managed-profile-claim",schema:"1",running:false,status:"created",network:"none",readonly:true,mounts:0,ports:0});
      throw Error("unexpected_dispatch");
    };
    await assert.rejects(() => action === "install" ? runtime.installTrustBundle() : runtime.destroy(),/managed_profile_busy/);
    assert.ok(!commands.some(args => ["run","start","exec","rm","volume"].includes(args[0])));
  }
});

test("manual recovery prevalidates every namespace and refuses absent or live ambiguity", async () => {
  for (const shape of ["absent","live","foreign_init"] as const) {
    const runtime = ManagedCliRuntime.restore({owner,provider:"claude"}), commands:string[][]=[];
    (runtime as any).command = async (args:string[]) => {
      commands.push(args);
      if (args[0] === "inspect" && args.at(-1) === fixtureLeaseId) return JSON.stringify({id:fixtureLeaseId,name:`/cg-managed-lease-${owner}`,owner,provider:"claude",operation,kind:"managed-profile-claim",schema:"1",running:false,status:"created",network:"none",readonly:true,mounts:0,ports:0});
      if (args[0] === "inspect") return JSON.stringify(evidence({id:args.at(-1) === runtime.container ? id : "b".repeat(64),operation:args.at(-1) === runtime.container || shape !== "foreign_init" ? operation : randomUUID(),running:shape === "live",status:shape === "live" ? "running" : "exited"}));
      if (args.includes(`name=^/${runtime.container}$`)) return shape === "absent" ? "" : runtime.container;
      if (args.includes(`name=^/cg-managed-init-${owner}$`)) return shape === "foreign_init" ? `cg-managed-init-${owner}` : "";
      throw Error("unexpected_dispatch");
    };
    await assert.rejects(() => runtime.recoverStopped({operation,lease_id:fixtureLeaseId,owner_quiesced:true}));
    assert.ok(!commands.some(args => args[0] === "rm" || args[0] === "volume"));
  }
});

test("manual recovery needs affirmative owner quiescence before Docker dispatch", async () => {
  const runtime = ManagedCliRuntime.restore({owner,provider:"codex"}); let calls = 0;
  (runtime as any).command = async () => { calls++; throw Error("unexpected_dispatch"); };
  await assert.rejects(() => runtime.recoverStopped({operation,lease_id:fixtureLeaseId,owner_quiesced:false} as any));
  assert.equal(calls,0);
});

test("ordinary Claude profile starts with bundled roots and no implicit host-root selection", async () => {
  const {runtime,commands} = await fakeStartedRuntime();
  await runtime.start();
  const create = commands.find(args => args[0] === "create")!;
  assert.ok(create.includes("SSL_CERT_FILE=/opt/cg/ca.pem"));
  assert.ok(create.includes("NODE_EXTRA_CA_CERTS=/opt/cg/ca.pem"));
  assert.ok(!commands.some(args => args.includes(verifyManagedHostTrustScript)));
});

test("restored opt-in profile selects only its prepared root without loading host paths", async () => {
  const {runtime,commands} = await fakeStartedRuntime(selectedTrust());
  await runtime.start();
  const create = commands.find(args => args[0] === "create")!;
  assert.ok(create.includes("SSL_CERT_FILE=/opt/cg/optional-public-ca.pem"));
  const verification = commands.find(args => args.includes(verifyManagedHostTrustScript))!;
  assert.equal(verification.at(-1),JSON.stringify(runtime.identity().trust));
  assert.ok(!verification.includes(publicRoot));
});

test("unprepared or changed optional root fails closed and removes only captured operation ID", async () => {
  const {runtime,commands} = await fakeStartedRuntime(selectedTrust(),false);
  await assert.rejects(() => runtime.start(), /managed_host_trust_bundle_invalid/);
  assert.deepEqual(commands.find(args => args[0] === "rm"),["rm","--force",id]);
  assert.ok(!commands.some(args => args[0] === "volume" && args[1] === "rm"));
});

test("host trust installation requires explicit files and never dispatches for invalid selection", async () => {
  const runtime = ManagedCliRuntime.restore({owner,provider:"claude"});
  let calls = 0; (runtime as any).command = async () => { calls++; throw Error("unexpected_dispatch"); };
  await assert.rejects(() => runtime.installClaudeHostTrust(undefined as any), /managed_host_trust_selection_required/);
  await assert.rejects(() => ManagedCliRuntime.prepare("codex",{hostTrust:{pemPath:"unused",proofPath:"unused"}}), /managed_profile_trust_provider_invalid/);
  const directory = await mkdtemp(path.join(tmpdir(),"cg-public-trust-fixture-"));
  const pemPath = path.join(directory,"public.pem"), proofPath = path.join(directory,"proof.json");
  try {
    await writeFile(pemPath,publicRoot); await writeFile(proofPath,JSON.stringify({...trustProof,purpose:"wrong"}));
    await assert.rejects(() => runtime.installClaudeHostTrust({pemPath,proofPath}), /managed_host_trust_invalid/);
    assert.equal(calls,0); assert.equal(runtime.identity().trust,undefined);
  } finally { await rm(pemPath,{force:true}); await rm(proofPath,{force:true}); await rmdir(directory); }
});

test("explicit public root install publishes selection only after successful offline tools-only operation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(),"cg-public-trust-install-fixture-"));
  const pemPath = path.join(directory,"public.pem"), proofPath = path.join(directory,"proof.json");
  try {
    await writeFile(pemPath,publicRoot); await writeFile(proofPath,JSON.stringify(trustProof));
    for (const fail of [true,false]) {
      const runtime = ManagedCliRuntime.restore({owner,provider:"claude"}), commands:string[][]=[];
      let initExists = false;
      installLeaseFixture(runtime, async (args:string[]) => {
        commands.push(args);
        if (args[0] === "volume") return owner;
        if (args[0] === "create") { initExists = true; return id; }
        if (args[0] === "inspect") return JSON.stringify(evidence({operation:runtime.operationIdentity().operation,status:"created"}));
        if (args[0] === "start" && fail) throw Error("fixture_delivery_failed");
        if (args[0] === "rm") { initExists = false; return ""; }
        if (args.includes(`id=${id}`)) return initExists ? id : "";
        return "";
      });
      if (fail) { await assert.rejects(() => runtime.installClaudeHostTrust({pemPath,proofPath}), /fixture_delivery_failed/); assert.equal(runtime.identity().trust,undefined); }
      else { await runtime.installClaudeHostTrust({pemPath,proofPath}); assert.deepEqual(runtime.identity().trust,selectedTrust()); }
      const create = commands.find(args => args[0] === "create")!;
      assert.equal(create[create.indexOf("--network")+1],"none");
      assert.ok(create.includes(installManagedHostTrustScript));
      assert.equal(create.filter(arg => arg.startsWith("type=volume,")).length,1);
      assert.ok(create.includes(`type=volume,src=${runtime.toolsVolume},dst=/opt/cg,volume-nocopy`));
      assert.ok(!create.some(arg => arg.includes(runtime.authVolume)));
      assert.ok(commands.some(args => args[0] === "start" && args.includes("--attach") && args.at(-1) === id));
    }
  } finally { await rm(pemPath,{force:true}); await rm(proofPath,{force:true}); await rmdir(directory); }
});
