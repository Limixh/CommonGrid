// F0 only: private managed-login home, read-only public tools and stdio egress.
// No host credential path, Docker socket, task workspace or published port.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Readable } from "node:stream";
import { dockerCommand, DockerCommandError, TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
import { executeTaskTool } from "../../packages/agent-adapters/src/task-tool.ts";
import { type SubscriptionProvider } from "../../packages/agent-adapters/src/egress-policy.ts";
import { attachManagedControl } from "./managed-control.mts";
import { assertCodingProfileVerified } from "./codex-profile.mts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = JSON.parse(await readFile(new URL("../sandbox/image.lock.json", import.meta.url),"utf8"));
const pins = JSON.parse(await readFile(new URL("binaries.lock.json", import.meta.url),"utf8"));
const labelKey = "io.commongrid.spike.owner";
const operationLabelKey = "io.commongrid.spike.operation";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface ManagedContainerEvidence { id: string; owner: string; operation: string; running: boolean; status: string }
export interface ManagedOperationOptions { signal?: AbortSignal }
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
  if (result.code !== 0) throw new Error("managed_docker_failed");
  return result.stdout.trim();
}
async function digest(source: string) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest("hex");
}
export interface SessionIdentity { owner: string; provider: SubscriptionProvider }
async function claudeLocalTrust() {
  try {
    const proof=JSON.parse(await readFile(path.join(root,".local/managed-session/claude-windows-root.proof.json"),"utf8"));
    const pem=await readFile(path.join(root,".local/managed-session/claude-windows-root.pem"),"utf8");
    const certificate=new X509Certificate(pem);
    assert.equal(proof.windows_tls_verified,true);assert.equal(proof.installed_root,true);assert.equal(proof.private_key_exported,false);
    assert.equal(createHash("sha256").update(certificate.raw).digest("hex"),proof.certificate_sha256);
    assert.equal(certificate.ca,true);assert.equal(certificate.subject,certificate.issuer);
    return {pem,sha256:proof.certificate_sha256};
  }catch(error:any){if(error.code==="ENOENT")return undefined;throw new Error("managed_host_trust_invalid");}
}
export class ManagedCliRuntime {
  readonly owner: string;
  readonly provider: SubscriptionProvider;
  readonly container: string;
  readonly toolsVolume: string;
  readonly authVolume: string;
  private readonly initContainer: string;
  private readonly operation = randomUUID();
  private starting = false;
  // A canceled create client can lose its ID while the daemon is still working.
  // Absence in a single listing cannot prove that mutation never completed.
  private uncertainCreate = false;
  private constructor(identity: SessionIdentity) {
    if (!uuidV4.test(identity.owner) || !["claude","codex"].includes(identity.provider)) throw new Error("managed_identity_invalid");
    this.owner = identity.owner; this.provider = identity.provider;
    this.container = `cg-managed-${this.provider}-${this.owner}`;
    this.initContainer = `cg-managed-init-${this.owner}`;
    this.toolsVolume = `cg-managed-tools-${this.owner}`;
    this.authVolume = `cg-managed-auth-${this.owner}`;
  }
  static restore(identity: SessionIdentity) { return new ManagedCliRuntime(identity); }
  identity(): SessionIdentity { return {owner:this.owner,provider:this.provider}; }
  operationIdentity() { return { ...this.identity(), operation: this.operation }; }
  private command(args: string[], options: ManagedOperationOptions = {}) { return checked(args, 30_000, options); }
  private async containerEvidence(name: string, options: ManagedOperationOptions = {}) {
    const evidence: unknown = JSON.parse(await this.command(["inspect", "--format", evidenceFormat, name], options));
    assertManagedContainerFence(evidence, this.owner);
    return evidence;
  }
  async verifyOperation(options: ManagedOperationOptions = {}) {
    const evidence = await this.containerEvidence(this.container, options);
    assertManagedContainerFence(evidence, this.owner, this.operation);
    assert.equal(evidence.running, true, "managed_operation_not_running");
    return evidence.id;
  }
  async verify(kind: "container" | "volume", name: string, options: ManagedOperationOptions = {}) {
    const field = kind === "container" ? ".Config.Labels" : ".Labels";
    assert.equal(await this.command([kind === "container" ? "inspect" : "volume", ...(kind === "container" ? [] : ["inspect"]),"--format",`{{index ${field} "${labelKey}"}}`,name], options),this.owner,"managed_owner_mismatch");
  }
  static async prepare(provider: SubscriptionProvider) {
    const runtime = new ManagedCliRuntime({owner:randomUUID(),provider});
    const source = path.join(root,".tools/cli-fixtures",provider);
    assert.equal(await digest(source),provider === "claude" ? pins.claude.sha256 : pins.codex.binary_sha256);
    const proof = JSON.parse(await readFile(path.join(root,".tools/cli-fixtures/verification.json"),"utf8"));
    assert.equal(proof.claude_manifest_signature_verified,true);
    assert.equal(proof.codex_binary_sha256,pins.codex.binary_sha256);
    try {
      for (const volume of [runtime.toolsVolume,runtime.authVolume]) await checked(["volume","create","--label",`${labelKey}=${runtime.owner}`,volume]);
      const initId = await checked(["create","--name",runtime.initContainer,"--label",`${labelKey}=${runtime.owner}`,"--label",`io.commongrid.spike.operation=${runtime.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--cap-add","CHOWN","--security-opt","no-new-privileges","--memory","512m","--memory-swap","512m","--pids-limit","32",
        "--mount",`type=volume,src=${runtime.toolsVolume},dst=/opt/cg,volume-nocopy`,"--mount",`type=volume,src=${runtime.authVolume},dst=/home/node,volume-nocopy`,base.image,"node","-e","setTimeout(()=>process.exit(0),600000)"]);
      assert.match(initId, /^[a-f0-9]{64}$/, "managed_container_id_invalid");
      const initEvidence = await runtime.containerEvidence(initId);
      assertManagedContainerFence(initEvidence, runtime.owner, runtime.operation);
      assert.equal(initEvidence.id, initId, "managed_container_id_mismatch");
      await checked(["start",initId]);
      for (const [from,to] of [[source,`/opt/cg/${provider}`],...["runtime-bridge.mjs","tunnel-wire.mjs","mcp.mjs","task-broker.mjs"].map(file => [fileURLToPath(new URL(file,import.meta.url)),`/opt/cg/${file}`])]) {
        const result = await dockerCommand(["exec","-i",initId,"node","-e","const fs=require('node:fs');const o=fs.createWriteStream(process.argv[1],{flags:'wx',mode:0o555});o.on('error',()=>process.exit(1));process.stdin.pipe(o)",to],{timeoutMs:180_000,stdin:createReadStream(from)});
        assert.equal(result.code,0,"managed_public_delivery_failed");
      }
      await checked(["exec",initId,"node","-e","require('node:fs').writeFileSync('/opt/cg/ca.pem',require('node:tls').rootCertificates.join('\\n')+'\\n',{flag:'wx',mode:0o444});"]);
      // Fresh Claude profiles must install the same validated public CA bundle
      // that start() selects. No existing private profile is changed here.
      const extra = provider === "claude" ? await claudeLocalTrust() : undefined;
      if (extra) await checked(["exec",initId,"node","-e","require('node:fs').writeFileSync('/opt/cg/claude-ca.pem',require('node:tls').rootCertificates.join('\\n')+'\\n'+process.argv[1],{flag:'wx',mode:0o444});","--",extra.pem]);
      await checked(["exec",initId,"/bin/chmod","0700","/home/node"]);
      await checked(["exec",initId,"/bin/chown","1000:1000","/home/node"]);
      await checked(["exec",initId,"/bin/chmod","0555","/opt/cg"]);
      await runtime.stopOperationContainer(initId);
      return runtime;
    } catch (error) {
      try { await runtime.destroy(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "managed_prepare_cleanup_unconfirmed"); }
      throw error;
    }
  }
  async installTrustBundle() {
    // Repair an already prepared F0 cache from the same pinned image. Never
    // mount auth, use host trust files, disable TLS or update an active profile.
    assert.equal(await checked(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"]),"","managed_profile_busy");
    await this.verify("volume",this.toolsVolume);
    const script="const f=require('node:fs'),bundle=require('node:tls').rootCertificates.join('\\n')+'\\n';if(f.existsSync('/opt/cg/ca.pem')){if(f.readFileSync('/opt/cg/ca.pem','utf8')!==bundle)throw Error('invalid_bundle');}else{f.chmodSync('/opt/cg',0o755);try{f.writeFileSync('/opt/cg/ca.pem',bundle,{flag:'wx',mode:0o444});}finally{f.chmodSync('/opt/cg',0o555);}}";
    try {await checked(["run","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,base.image,"node","-e",script]);}finally{await this.stop();}
  }
  async installClaudeHostTrust() {
    assert.equal(this.provider,"claude");const extra=await claudeLocalTrust();assert.ok(extra,"managed_host_trust_proof_required");
    assert.equal(await checked(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"]),"","managed_profile_busy");await this.verify("volume",this.toolsVolume);
    const script="const f=require('node:fs'),bundle=require('node:tls').rootCertificates.join('\\n')+'\\n'+process.argv[1];if(f.existsSync('/opt/cg/claude-ca.pem')){if(f.readFileSync('/opt/cg/claude-ca.pem','utf8')!==bundle)throw Error('invalid_bundle');}else{f.chmodSync('/opt/cg',0o755);try{f.writeFileSync('/opt/cg/claude-ca.pem',bundle,{flag:'wx',mode:0o444});}finally{f.chmodSync('/opt/cg',0o555);}}";
    try{await checked(["run","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,base.image,"node","-e",script,"--",extra.pem]);}finally{await this.stop();}
  }
  async installCodexCodingProfile() {
    assert.equal(this.provider,"codex");const catalog=await assertCodingProfileVerified();
    assert.equal(await checked(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"]),"","managed_profile_busy");await this.verify("volume",this.toolsVolume);
    const script="const f=require('node:fs'),catalog=f.readFileSync(0,'utf8');f.chmodSync('/opt/cg',0o755);try{if(f.existsSync('/opt/cg/catalog.json')){if(f.readFileSync('/opt/cg/catalog.json','utf8')!==catalog)throw Error('profile_mismatch');}else f.writeFileSync('/opt/cg/catalog.json',catalog,{flag:'wx',mode:0o444});}finally{f.chmodSync('/opt/cg',0o555);}";
    try{assert.equal((await dockerCommand(["run","-i","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,base.image,"node","-e",script],{timeoutMs:30_000,stdin:Readable.from([catalog.value])})).code,0);}finally{await this.stop();}
  }
  async start(options: ManagedOperationOptions = {}) {
    assertActiveSignal(options.signal);
    assert.ok(!this.starting, "managed_start_in_progress");
    assert.ok(!this.uncertainCreate, "managed_cleanup_unconfirmed");
    this.starting = true;
    let createDispatched = false, containerId: string | undefined;
    const invoke = (args: string[]) => this.command(args, options);
    try {
    await this.verify("volume",this.authVolume, options); await this.verify("volume",this.toolsVolume, options);
    assert.equal(await invoke(["container", "ls", "--all", "--filter", `name=^/${this.container}$`, "--format", "{{.Names}}"]), "", "managed_profile_busy");
    const extra=this.provider==="claude"?await claudeLocalTrust():undefined;
    const ca=extra?"/opt/cg/claude-ca.pem":"/opt/cg/ca.pem";
    assertActiveSignal(options.signal);
    createDispatched = true;
    containerId = await invoke(["create","--name",this.container,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","1000:1000","--workdir","/home/node","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","96","--cpus","1","--memory","1024m","--memory-swap","1024m","--init",
      "--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,readonly,volume-nocopy`,"--mount",`type=volume,src=${this.authVolume},dst=/home/node,volume-nocopy`,"--tmpfs","/tmp:rw,noexec,nosuid,size=128m",
      "--env","HTTPS_PROXY=http://127.0.0.1:9877","--env","HTTP_PROXY=http://127.0.0.1:9877","--env","ALL_PROXY=http://127.0.0.1:9877","--env","NO_PROXY=127.0.0.1,localhost",
      "--env","CODEX_CA_CERTIFICATE=/opt/cg/ca.pem","--env",`SSL_CERT_FILE=${ca}`,
      "--env",`NODE_EXTRA_CA_CERTS=${ca}`,
      "--env","CLAUDE_CONFIG_DIR=/home/node/claude","--env","DISABLE_AUTOUPDATER=1","--env","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1","--env","ENABLE_CLAUDEAI_MCP_SERVERS=false","--env","ENABLE_TOOL_SEARCH=false","--env","CLAUDE_CODE_DISABLE_ARTIFACT=1",
      "--env",`CG_TOOL_TOKEN=${randomBytes(32).toString("hex")}`,base.image,"node","-e","setTimeout(()=>process.exit(0),900000)"]);
    assert.match(containerId, /^[a-f0-9]{64}$/, "managed_container_id_invalid");
      const evidence = await this.containerEvidence(containerId, options);
      assertManagedContainerFence(evidence, this.owner, this.operation);
      assert.equal(evidence.id, containerId, "managed_container_id_mismatch");
      await invoke(["start",containerId]);
      const hash = await invoke(["exec",containerId,"node","-e",`const fs=require('node:fs'),c=require('node:crypto'),h=c.createHash('sha256');const s=fs.createReadStream('/opt/cg/${this.provider}');s.on('data',b=>h.update(b));s.on('end',()=>console.log(h.digest('hex')));`]);
      assert.equal(hash,this.provider === "claude" ? pins.claude.sha256 : pins.codex.binary_sha256,"managed_binary_tampered");
      for(const file of ["runtime-bridge.mjs","tunnel-wire.mjs","mcp.mjs","task-broker.mjs"]) {
        const actual=await invoke(["exec",containerId,"node","-e",`console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/opt/cg/${file}')).digest('hex'));`]);
        assert.equal(actual,await digest(fileURLToPath(new URL(file,import.meta.url))),"managed_bridge_source_changed_reprepare_required");
      }
      assert.equal(await invoke(["exec",containerId,"node","-e","console.log(require('node:fs').readFileSync('/opt/cg/ca.pem','utf8')===require('node:tls').rootCertificates.join('\\n')+'\\n');"]),"true","managed_trust_bundle_invalid");
      if(extra)assert.equal(await invoke(["exec",containerId,"node","-e","console.log(require('node:fs').readFileSync('/opt/cg/claude-ca.pem','utf8')===require('node:tls').rootCertificates.join('\\n')+'\\n'+process.argv[1]);","--",extra.pem]),"true","managed_host_trust_bundle_invalid");
      assertActiveSignal(options.signal);
    } catch (error) {
      if (createDispatched) {
        // The canceled create client may lose its returned ID. Reconcile only
        // this operation, with a fresh deadline independent of caller abort.
        const cleanupOptions = { signal: AbortSignal.timeout(30_000) };
        if (!containerId && error instanceof DockerCommandError) this.uncertainCreate = true;
        if (containerId !== undefined && !/^[a-f0-9]{64}$/.test(containerId)) this.uncertainCreate = true;
        try {
          if (containerId && /^[a-f0-9]{64}$/.test(containerId)) await this.stopOperationContainer(containerId, cleanupOptions);
          else await this.stop(false, cleanupOptions);
        } catch (cleanupError) { throw new AggregateError([error, cleanupError], "managed_start_cleanup_unconfirmed"); }
      }
      throw error;
    } finally { this.starting = false; }
  }
  async exec(args: string[], timeoutMs = 15_000, options: { signal?: AbortSignal; maxBytes?: number } = {}) {
    assertActiveSignal(options.signal);
    if (!args.length || args.some(arg => typeof arg !== "string" || arg.includes("\0")) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1_048_576))) throw new Error("managed_exec_arguments_invalid");
    const containerId = await this.verifyOperation(options);
    try { return await dockerCommand(["exec",containerId,...args],{...options,timeoutMs}); }
    catch(error) {
      // Killing a Docker client does not guarantee its exec descendants exit.
      // Tear down only this operation; its private home remains on the volume.
      // Capture the dispatched ID: a replacement with even the same operation
      // label must survive this older exec's asynchronous cleanup.
      await this.stopOperationContainer(containerId, { signal: AbortSignal.timeout(30_000) }); throw error;
    }
  }
  private async stopOperationContainer(containerId: string, options: ManagedOperationOptions = {}) {
    await removeManagedOperationContainer(containerId, this.owner, this.operation, args => this.command(args, options), options);
  }
  async stop(explicitDestroy = false, options: ManagedOperationOptions = {}) {
    assertActiveSignal(options.signal);
    for (const name of [this.container,this.initContainer]) {
      const listed = await this.command(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"], options);
      if (!listed.split(/\r?\n/).includes(name)) continue;
      const evidence = await this.containerEvidence(name, options);
      // A competing command using this profile must not delete the incumbent.
      if(!explicitDestroy&&evidence.operation!==this.operation)continue;
      await removeManagedContainer(evidence,this.owner,explicitDestroy?undefined:this.operation, false, args => this.command(args, options), options);
      if (name === this.container && evidence.operation === this.operation) this.uncertainCreate = false;
    }
    assertActiveSignal(options.signal);
    assert.ok(!this.uncertainCreate, "managed_cleanup_unconfirmed");
  }
  async recoverStopped(expectedOperation: string) {
    assert.ok(uuidV4.test(expectedOperation), "managed_operation_invalid");
    let recovered = 0;
    for (const name of [this.container, this.initContainer]) {
      const listed = await checked(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"]);
      if (!listed.split(/\r?\n/).includes(name)) continue;
      const evidence = await this.containerEvidence(name);
      await removeManagedContainer(evidence,this.owner,expectedOperation,true); recovered++;
    }
    // Reference reconciliation only: no profile lock, crash detector, auth
    // destruction or automatic takeover of another live operation.
    return { recovered_containers: recovered, private_volumes_retained: true };
  }
  async destroy() {
    await this.stop(true);
    for (const name of [this.authVolume,this.toolsVolume]) {
      const listed = await checked(["volume","ls","--filter",`name=${name}`,"--format","{{.Name}}"]);
      if (!listed.split(/\r?\n/).includes(name)) continue;
      await this.verify("volume",name); await checked(["volume","rm",name]);
      assert.ok(!(await checked(["volume","ls","--filter",`name=${name}`,"--format","{{.Name}}"])).split(/\r?\n/).includes(name));
    }
  }
}

export async function startBridge(runtime: ManagedCliRuntime, task?: TaskToolsRuntime) {
  const containerId = await runtime.verifyOperation();
  const child = spawn("docker",["exec","-i",containerId,"node","/opt/cg/runtime-bridge.mjs"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  const control = attachManagedControl(child, {provider:runtime.provider, ...(task ? {execute: (arguments_: unknown) => executeTaskTool(task, arguments_)} : {})});
  try { await control.ready; assert.equal(control.stats.control_failure,false,"managed_bridge_failed"); } catch (error) { control.close(); throw error; }
  return {stats:control.stats,close:control.close,child:control.child};
}

export const taskImage: string = base.image;
