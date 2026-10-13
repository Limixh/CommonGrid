import { readFile, mkdir, writeFile } from "node:fs/promises";
import { buildArtifactBundle, type ArtifactBinding } from "../../packages/agent-adapters/src/artifact-bundle.ts";
import { buildSoftwareResultBundle } from "../../packages/agent-adapters/src/software-result.ts";
import { createControlledPatch } from "../../packages/agent-adapters/src/controlled-task.ts";
import { softwareBaseline } from "../../packages/agent-adapters/src/software-task.ts";
import type { TaskContract } from "@commongrid/task-schema";
const catalog = JSON.parse(await readFile(new URL("../../packages/task-schema/fixtures/catalog.json", import.meta.url), "utf8"));
const task: TaskContract = catalog.tasks[1];
const binding: ArtifactBinding = { purpose: "result", task_id:task.id, task_version:task.task_version,contract_hash:task.contract_hash,lease_id:"lease-client-fixture",base_commit:task.workspace.commit,strategy_id:task.strategies[0].id };
// This fixture establishes the wire protocol, never a scanner acceptance.
const bundle = await buildArtifactBundle(task,binding,[{path:"src/search.ts",bytes:Buffer.from("export function lower_bound() { return 0; }\n")}],async()=>{});
const directory = new URL("../../services/coordinator/internal/artifact/testdata/", import.meta.url);
await mkdir(directory,{recursive:true});
await writeFile(new URL("client-bundle.zip", directory),bundle.bytes);
await writeFile(new URL("client-binding.json", directory),JSON.stringify(binding,null,2)+"\n");
await writeFile(new URL("client-task.json", directory),JSON.stringify(task,null,2)+"\n");
console.log(`Client artifact fixture: ${bundle.size_bytes} bytes; sha256=${bundle.sha256}`);

// Real software-result package: the reference fix of the pinned software-bounds
// baseline goes through the same patch -> candidate -> bundle path the worker
// uses. Local text inspection only; this is never a scanner acceptance.
const reference = softwareBaseline.replace("values.length - 1", "values.length");
if (reference === softwareBaseline) throw new Error("software reference fix did not apply");
const created = createControlledPatch(reference, softwareBaseline, "software-bounds");
const resultBinding: ArtifactBinding = { ...binding, strategy_id: "invariant" };
const result = await buildSoftwareResultBundle(task, { baseline: softwareBaseline, strategyId: resultBinding.strategy_id, leaseId: resultBinding.lease_id, patch: created.patch, candidateSha256: created.candidate_sha256 });
await writeFile(new URL("software-result-bundle.zip", directory),result.bytes);
await writeFile(new URL("software-result-binding.json", directory),JSON.stringify(resultBinding,null,2)+"\n");
console.log(`Software result fixture: ${result.size_bytes} bytes; sha256=${result.sha256}`);
