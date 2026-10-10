// F0 developer adapter: repo fixtures/proofs are deliberately outside product code.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ManagedCliRuntime as CoreRuntime, type ManagedRuntimeAssets, type ManagedJournalOptions as CoreJournalOptions, type SessionIdentity, type ManagedOperationOptions, type ManagedHostTrustOptions } from "../../packages/agent-adapters/src/managed-runtime.ts";
import { assertCodingProfileVerified } from "./codex-profile.mts";
export * from "../../packages/agent-adapters/src/managed-runtime.ts";
const root=fileURLToPath(new URL("../../",import.meta.url));
const base=JSON.parse(await readFile(new URL("../sandbox/image.lock.json",import.meta.url),"utf8"));
const pins=JSON.parse(await readFile(new URL("binaries.lock.json",import.meta.url),"utf8"));
const labelKey="io.commongrid.spike.owner";
export const taskImage: string=base.image;
export interface ManagedJournalOptions extends CoreJournalOptions { journalRoot?: string }
type SpikeOptions = ManagedJournalOptions & {assets?:ManagedRuntimeAssets};
function fixtureAssets(options:SpikeOptions):ManagedRuntimeAssets { return options.assets ?? {
  baseImage:base.image, journalRoot:options.journalRoot ?? path.join(root,".local/managed-operation-journal"),
  bridgeRoot:path.join(root,"packages/agent-adapters/runtime-assets"),
  binaries:{claude:{binaryPath:path.join(root,".tools/cli-fixtures/claude"),sha256:pins.claude.sha256},codex:{binaryPath:path.join(root,".tools/cli-fixtures/codex"),sha256:pins.codex.binary_sha256}}
}; }
export class ManagedCliRuntime extends CoreRuntime {
  static override restore(identity:SessionIdentity,options:SpikeOptions={}) { return new ManagedCliRuntime(identity,{...options,assets:fixtureAssets(options)}); }
  static override async prepare(provider:"claude"|"codex",options:SpikeOptions & {hostTrust?:ManagedHostTrustOptions;signal?:AbortSignal}={}) {
    if(options.hostTrust!==undefined)assert.equal(provider,"claude","managed_profile_trust_provider_invalid");
    if(!options.assets) {
      const proof=JSON.parse(await readFile(path.join(root,".tools/cli-fixtures/verification.json"),"utf8"));
      assert.equal(proof.claude_manifest_signature_verified,true);assert.equal(proof.codex_binary_sha256,pins.codex.binary_sha256);
    }
    const trusted={...options,assets:fixtureAssets(options)};
    return super.prepareRuntime(new ManagedCliRuntime({owner:randomUUID(),provider},trusted),trusted);
  }
  async installCodexCodingProfile(options: ManagedOperationOptions = {}) { return this.mutation(() => this.installCodexCodingProfileInternal(options),true); }
  private async installCodexCodingProfileInternal(options: ManagedOperationOptions) {
    assert.equal(this.provider,"codex");const catalog=await assertCodingProfileVerified(); await this.beginInternal(options);
    assert.equal(await this.ownedCommand(["container","ls","--all","--filter",`name=^/${this.container}$`,"--format","{{.Names}}"],options),"","managed_profile_busy");await this.verify("volume",this.toolsVolume,options);
    const script="const f=require('node:fs'),catalog=f.readFileSync(0,'utf8');f.chmodSync('/opt/cg',0o755);try{if(f.existsSync('/opt/cg/catalog.json')){if(f.readFileSync('/opt/cg/catalog.json','utf8')!==catalog)throw Error('profile_mismatch');}else f.writeFileSync('/opt/cg/catalog.json',catalog,{flag:'wx',mode:0o444});}finally{f.chmodSync('/opt/cg',0o555);}";
    await this.installContainer(["create","-i","--name",this.initContainer,"--label",`${labelKey}=${this.owner}`,"--label",`io.commongrid.spike.operation=${this.operation}`,"--network","none","--read-only","--user","0:0","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${this.toolsVolume},dst=/opt/cg,volume-nocopy`,this.assets.baseImage,"node","-e",script],Readable.from([catalog.value]),options);
  }
}
