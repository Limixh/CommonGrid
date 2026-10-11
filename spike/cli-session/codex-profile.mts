// A pinned, explicit F0 tool profile. No provider/auth/entitlement override.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { codexFunctionalTestModel } from "@commongrid/agent-adapters/testing/functional-test-models";
import pins from "../../packages/agent-adapters/runtime-assets/native-cli-assets.lock.json";
import { deriveCodexCodingCatalog } from "../../scripts/codex-coding-catalog.mjs";
export const codexCodingModel=codexFunctionalTestModel;
// The pin and the deterministic transform are shared with the product launcher asset.
export const catalogSource={url:pins.codex_catalog.source_url,sha256:pins.codex_catalog.source_sha256};
const root=fileURLToPath(new URL("../../",import.meta.url));
export const profileFile=path.join(root,".local/codex-profile/catalog.json");
export const profileProof=path.join(root,".local/codex-profile/fixture-proof.json");
export async function codingCatalog() {
  const source=await readFile(path.join(root,".local/cli-routing/sources/codex-models.txt"));
  const {value,sha256}=deriveCodexCodingCatalog(source,{model:codexCodingModel,source_sha256:catalogSource.sha256});
  assert.equal(sha256,pins.codex_catalog.sha256,"codex_catalog_derivation_mismatch");
  await mkdir(path.dirname(profileFile),{recursive:true});await writeFile(profileFile,value);
  return {value,sha256};
}
export async function assertCodingProfileVerified() {
  const catalog=await codingCatalog(),proof=JSON.parse(await readFile(profileProof,"utf8"));
  assert.equal(proof.success,true);assert.equal(proof.catalog_sha256,catalog.sha256);assert.equal(proof.model,codexCodingModel);
  assert.deepEqual(proof.advertised_tools,["functions.task_exec"]);
  assert.match(proof.source_run_id,/^[0-9a-f-]{36}$/);
  const report=JSON.parse(await readFile(path.join(root,".local/cli-session",proof.source_run_id,"report.json"),"utf8"));
  assert.equal(report.success,true);assert.equal(report.cleanup_confirmed,true);assert.equal(report.providers.codex.fixture_model,codexCodingModel);assert.equal(report.providers.codex.catalog_sha256,catalog.sha256);
  return catalog;
}
