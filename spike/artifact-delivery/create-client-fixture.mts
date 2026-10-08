import { readFile, mkdir, writeFile } from "node:fs/promises";
import { buildArtifactBundle, type ArtifactBinding } from "../../packages/agent-adapters/src/artifact-bundle.ts";
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
