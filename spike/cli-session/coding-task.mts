// Controlled one-file coding acceptance fixture, not a general artifact importer.
// The agent never receives the oracle or verifier filesystem/network/identity.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskToolsRuntime, dockerCommand } from "../../packages/agent-adapters/src/task-runtime.ts";
import { runOwnedCommand } from "../../packages/agent-adapters/src/owned-process.ts";
import { checked, taskImage } from "./managed-runtime.mts";
import { codingCandidateSnapshotScript, validateCodingCandidateBytes, validateCodingCandidateSource } from "./coding-artifact.mjs";

export const baseline = "export function sumIntegers(values) { return values.reduce((total, value) => total + value); }\n";
export const correctCandidate = "export function sumIntegers(values) {\n  if (!Array.isArray(values)) throw new TypeError('Expected an array');\n  let total = 0;\n  for (const value of values) {\n    if (!Number.isSafeInteger(value)) throw new TypeError('Expected safe integers');\n    total += value;\n    if (!Number.isSafeInteger(total)) throw new RangeError('Unsafe sum');\n  }\n  return total;\n}\n";
export const taskExecDescription = 'Execute argv directly in the isolated /task workspace, without credentials or network. The working directory is /task. There is no implicit shell and no stdin delivery. Node is available: use ["node", "-e", "JavaScript source"] to read or edit files. If a shell is needed, explicitly pass ["/bin/sh", "-c", "shell source"]. Commands default to a 3000 ms timeout; optional timeout_ms must be an integer from 1 to 30000.';
export const codingPrompt = "Fix /task/sum.mjs using only task_exec. Export sumIntegers(values). Accept arrays of safe integers only; otherwise throw TypeError. Empty array returns 0. Add from left to right and throw RangeError whenever the running sum is not a safe integer. Use Node argv to read and edit the existing file, and try examples in the task workspace. Do not change the filename or create other files. The independent verifier runs elsewhere. Report a short completion.\n\nTask tool contract: " + taskExecDescription;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export async function seedTask(runtime: TaskToolsRuntime) {
  const result=await runtime.exec(["node","-e",`require('node:fs').writeFileSync('/task/sum.mjs',${JSON.stringify(baseline)},{flag:'wx'});`]);assert.equal(result.code,0);
}
export async function writeCandidate(runtime: TaskToolsRuntime, source: string) {
  const result=await runtime.exec(["node","-e",`require('node:fs').writeFileSync('/task/sum.mjs',${JSON.stringify(source)});`]);assert.equal(result.code,0);
}
export async function snapshotCandidate(runtime: TaskToolsRuntime): Promise<string> {
  await runtime.inspect();
  const owner=randomUUID(),name=`cg-export-${owner}`;
  await checked(["pause",runtime.container]);
  try {
    const script=codingCandidateSnapshotScript;
    const result=await dockerCommand(["run","--name",name,"--label",`io.commongrid.spike.owner=${owner}`,"--network","none","--read-only","--user","65532:65532","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","128m","--pids-limit","16","--mount",`type=volume,src=${runtime.volume},dst=/task,readonly,volume-nocopy`,taskImage,"node","-e",script],{timeoutMs:30_000,maxBytes:65_536});
    assert.equal(result.code,0,"candidate_snapshot_rejected");
    const encoded=result.stdout.trim();
    assert.ok(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),"candidate_snapshot_encoding");
    const bytes=Buffer.from(encoded,"base64");
    assert.equal(bytes.toString("base64"),encoded,"candidate_snapshot_encoding");
    return validateCodingCandidateBytes(bytes);
  }finally {
    const found=await checked(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"]);
    if(found){assert.equal(await checked(["inspect","--format",'{{index .Config.Labels "io.commongrid.spike.owner"}}',name]),owner);await checked(["rm","--force",name]);}
    await checked(["unpause",runtime.container]);
  }
}
function oracle(values: unknown): {value?:number;error?:string} {
  if(!Array.isArray(values))return {error:"TypeError"};
  let total=0;for(const value of values){if(!Number.isSafeInteger(value))return {error:"TypeError"};total+=value as number;if(!Number.isSafeInteger(total))return {error:"RangeError"};}return {value:total};
}
export async function verifyCandidate(source: string) {
  validateCodingCandidateSource(source);
  const staging=await TaskToolsRuntime.create({image:taskImage,cpu:1,memoryMb:256},120_000);
  const owner=randomUUID(),name=`cg-verifier-${owner}`;
  try {
    await writeCandidate(staging,source);
    await checked(["create","--name",name,"--label",`io.commongrid.spike.owner=${owner}`,"--network","none","--read-only","--user","65532:65532","--workdir","/task","--cap-drop","ALL","--security-opt","no-new-privileges","--memory","256m","--memory-swap","256m","--pids-limit","32","--cpus","1","--init","--tmpfs","/tmp:rw,noexec,nosuid,size=16m","--mount",`type=volume,src=${staging.volume},dst=/task,readonly,volume-nocopy`,taskImage,"node","-e","setTimeout(()=>process.exit(0),120000)"]);
    await checked(["start",name]);
    // Host oracle is independent of all candidate code and files. Random cases
    // are generated after export; no expected answer is passed to the child.
    const cases:unknown[]=[[],[1,2,3],[-7,4,-2],[0],[Number.MAX_SAFE_INTEGER],[Number.MAX_SAFE_INTEGER,1],[Number.MIN_SAFE_INTEGER,-1],[1.2],["2"],null,{},[true]];
    const random=Buffer.from(randomUUID().replaceAll("-",""),"hex");
    for(let i=0;i<20;i++)cases.push(Array.from({length:i%8},(_,j)=>(random[(i+j)%random.length]-128)*17));
    const driver="const input=JSON.parse(process.argv[1]);const m=await import('/task/sum.mjs');const results=[];for(const x of input){try{results.push({value:await m.sumIntegers(x)})}catch(e){results.push({error:e.name})}}console.log(JSON.stringify(results));";
    const result=await dockerCommand(["exec",name,"node","--input-type=module","-e",driver,JSON.stringify(cases)],{timeoutMs:5000,maxBytes:16_384});
    let passed=false;try{assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),cases.map(oracle));passed=true;}catch{}
    const hash=await checked(["exec",name,"node","-e","const fs=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync('/task/sum.mjs')).digest('hex'));"],10_000);
    assert.equal(hash,sha256(source),"verifier_candidate_mutated");
    return {passed,cases:cases.length,candidate_sha256:hash,network:"none",workspace:"read_only",oracle:"host_private_expected_results",agent_access:false};
  }finally {
    const found=await checked(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"]);
    if(found){assert.equal(await checked(["inspect","--format",'{{index .Config.Labels "io.commongrid.spike.owner"}}',name]),owner);await checked(["rm","--force",name]);}
    await staging.close();
  }
}
export async function createDiff(source: string, directory: string) {
  validateCodingCandidateSource(source);
  directory=path.resolve(directory);
  // git apply supports operation outside a repository. An explicit absent
  // git-dir disables discovery of a parent repository: otherwise an ignored
  // .local subtree can make apply exit 0 after silently skipping the patch.
  const noRepository=path.join(directory,"git-discovery-disabled");
  await assert.rejects(access(noRepository),{code:"ENOENT"},"candidate_git_boundary");
  const applyIsolation=`--git-dir=${noRepository}`;
  for(const name of ["before","after"])await mkdir(path.join(directory,name),{recursive:true});
  await writeFile(path.join(directory,"before/sum.mjs"),baseline);await writeFile(path.join(directory,"after/sum.mjs"),source);
  const result=await runOwnedCommand("git",["-C",directory,"-c","core.autocrlf=false","diff","--no-index","--no-ext-diff","--no-textconv","--","before/sum.mjs","after/sum.mjs"]);
  assert.equal(result.code,1,"candidate_must_change_baseline");
  // Normalize only Git's fixed metadata headers, never candidate source lines.
  const lines=result.stdout.split("\n");
  assert.equal(lines[0],"diff --git a/before/sum.mjs b/after/sum.mjs","candidate_diff_header");
  assert.equal(lines[2],"--- a/before/sum.mjs","candidate_diff_header");
  assert.equal(lines[3],"+++ b/after/sum.mjs","candidate_diff_header");
  lines[0]="diff --git a/sum.mjs b/sum.mjs";lines[2]="--- a/sum.mjs";lines[3]="+++ b/sum.mjs";
  const patch=lines.join("\n");
  assert.ok(patch.startsWith("diff --git a/sum.mjs b/sum.mjs\n"));
  const patchFile=path.join(directory,"candidate.patch");await writeFile(patchFile,patch);
  assert.equal((await runOwnedCommand("git",["-C",path.join(directory,"before"),applyIsolation,"-c","core.autocrlf=false","apply","--check","--",patchFile])).code,0,"git_apply_check");
  const appliedDirectory=path.join(directory,"applied");await mkdir(appliedDirectory,{recursive:true});await writeFile(path.join(appliedDirectory,"sum.mjs"),baseline);
  assert.equal((await runOwnedCommand("git",["-C",appliedDirectory,applyIsolation,"-c","core.autocrlf=false","apply","--",patchFile])).code,0,"git_apply_roundtrip");
  const applied=await readFile(path.join(appliedDirectory,"sum.mjs"),"utf8");assert.equal(applied,source,"git_applied_candidate_mismatch");
  return {patch_file:patchFile,patch_sha256:sha256(patch),base_sha256:sha256(baseline),candidate_sha256:sha256(source),applied_candidate_sha256:sha256(applied),git_apply_check:true,git_apply_roundtrip:true};
}
