// A pinned, explicit F0 tool profile. No provider/auth/entitlement override.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { codexFunctionalTestModel } from "./functional-test-models.mts";
export const codexCodingModel=codexFunctionalTestModel;
export const catalogSource={url:"https://raw.githubusercontent.com/openai/codex/rust-v0.157.1/codex-rs/models-manager/models.json",sha256:"0178d235c589a31abd6ed0ea1e870935dc5819240eb0e813e178d3ebedf534f4"};
const root=fileURLToPath(new URL("../../",import.meta.url));
export const profileFile=path.join(root,".local/codex-profile/catalog.json");
export const profileProof=path.join(root,".local/codex-profile/fixture-proof.json");
export async function codingCatalog() {
  const source=await readFile(path.join(root,".local/cli-routing/sources/codex-models.txt"));
  assert.equal(createHash("sha256").update(source).digest("hex"),catalogSource.sha256,"codex_catalog_source_mismatch");
  const model=JSON.parse(source.toString("utf8")).models.find((model:any)=>model.slug===codexCodingModel);assert.ok(model);
  model.tool_mode="direct";model.multi_agent_version="disabled";model.experimental_supported_tools=[];
  const value=JSON.stringify({models:[model]},null,2)+"\n";
  const sha256=createHash("sha256").update(value).digest("hex");
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
