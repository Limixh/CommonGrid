import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
import { taskImage } from "./managed-runtime.mts";
import { baseline, correctCandidate, seedTask, writeCandidate, snapshotCandidate, verifyCandidate, createDiff } from "./coding-task.mts";
const directory=fileURLToPath(new URL(`../../.local/coding-verifier/${randomUUID()}/`,import.meta.url));await mkdir(directory,{recursive:true});
const report:Record<string,any>={checked_at:new Date().toISOString(),purpose:"controlled_coding_verifier_and_artifact_fixture",real_model_inference:false,real_account_tested:false,execution_enabled:false,isolation_gate:"not_evaluated",artifact_safety:{scope:"single_sum_mjs_fixture",secret_policy:"bounded_known_credential_shapes_and_literal_assignments",general_importer:false,production_secret_scanner:false},checks:[],cleanup_confirmed:false};
const task=await TaskToolsRuntime.create({image:taskImage,cpu:1,memoryMb:256},600_000);
try {
  assert.equal((await verifyCandidate(baseline)).passed,false);report.checks.push("broken_baseline_rejected");
  assert.equal((await verifyCandidate("process.exit(0);\n")).passed,false);report.checks.push("candidate_exit_zero_cannot_spoof_oracle");
  await seedTask(task);await writeCandidate(task,correctCandidate);const source=await snapshotCandidate(task);
  assert.equal(source,correctCandidate);report.checks.push("frozen_bounded_regular_file_snapshot");
  report.verifier=await verifyCandidate(source);assert.equal(report.verifier.passed,true);report.checks.push("independent_private_oracle_32_cases");
  report.diff=await createDiff(source,path.join(directory,"artifact"));report.checks.push("git_apply_check");
  assert.equal(report.diff.applied_candidate_sha256,report.verifier.candidate_sha256);report.checks.push("applied_patch_matches_verified_candidate_hash");
  const literalCandidate="const fixturePaths = 'a/before/sum.mjs and b/after/sum.mjs';\n"+correctCandidate;
  const literalVerifier=await verifyCandidate(literalCandidate);assert.equal(literalVerifier.passed,true);
  const literalDiff=await createDiff(literalCandidate,path.join(directory,"literal-artifact"));assert.equal(literalDiff.applied_candidate_sha256,literalVerifier.candidate_sha256);
  report.literal_artifact={verifier:literalVerifier,diff:literalDiff};report.checks.push("candidate_path_literals_preserved_in_verified_patch_roundtrip");
  await task.exec(["node","-e","const f=require('node:fs');f.writeFileSync('/task/other.mjs','extra');"]);
  await assert.rejects(()=>snapshotCandidate(task));report.checks.push("extra_file_rejected");
  await task.exec(["node","-e","const f=require('node:fs');f.unlinkSync('/task/other.mjs');f.unlinkSync('/task/sum.mjs');f.symlinkSync('/etc/passwd','/task/sum.mjs');"]);
  await assert.rejects(()=>snapshotCandidate(task));report.checks.push("symlink_without_extra_file_rejected");
  await task.exec(["node","-e",`const f=require('node:fs');f.unlinkSync('/task/sum.mjs');f.writeFileSync('/task/sum.mjs','x'.repeat(16385));`]);
  await assert.rejects(()=>snapshotCandidate(task));report.checks.push("oversized_candidate_rejected");
  const fixtures:[string,string][]=[
    ["hidden_auth_named_file_rejected", "f.writeFileSync('/task/sum.mjs','export const x=0;');f.writeFileSync('/task/.env','SYNTHETIC_NOT_AUTH');"],
    ["nested_git_directory_rejected", "f.writeFileSync('/task/sum.mjs','export const x=0;');f.mkdirSync('/task/.git');f.writeFileSync('/task/.git/config','SYNTHETIC_NOT_CONFIG');"],
    ["candidate_directory_rejected", "f.mkdirSync('/task/sum.mjs');"],
    ["candidate_fifo_rejected", "require('node:child_process').execFileSync('mkfifo',['/task/sum.mjs']);"],
    ["hardlink_with_second_entry_rejected", "f.writeFileSync('/task/sum.mjs','export const x=0;');f.linkSync('/task/sum.mjs','/task/link.mjs');if(f.lstatSync('/task/sum.mjs').nlink!==2)throw Error('fixture_hardlink');"],
    ["nul_content_rejected", "f.writeFileSync('/task/sum.mjs',Buffer.from([101,0,120]));"],
    ["invalid_utf8_rejected", "f.writeFileSync('/task/sum.mjs',Buffer.from([0xc3,0x28]));"],
    ["bidi_hidden_content_rejected", "f.writeFileSync('/task/sum.mjs','// '+String.fromCharCode(0x202e)+' concealed');"],
    ["synthetic_bearer_secret_rejected", "f.writeFileSync('/task/sum.mjs','// Bearer synthetic-canary-token-value');"],
    ["synthetic_private_key_rejected", "f.writeFileSync('/task/sum.mjs','// -----BEGIN PRIVATE KEY----- SYNTHETIC_NOT_A_KEY');"],
    ["synthetic_provider_token_rejected", "f.writeFileSync('/task/sum.mjs','// sk-proj-'+'synthetic_canary_'.repeat(3));"],
    ["synthetic_refresh_token_assignment_rejected", `f.writeFileSync('/task/sum.mjs',${JSON.stringify("const refresh_token = 'synthetic_canary_value';")});`],
  ];
  for(const [check,setup] of fixtures){
    const result=await task.exec(["node","-e",`const f=require('node:fs');for(const name of f.readdirSync('/task'))f.rmSync('/task/'+name,{recursive:true,force:true});${setup}`]);
    assert.equal(result.code,0,"artifact_fixture_setup");
    await assert.rejects(()=>snapshotCandidate(task),/candidate_snapshot_rejected/);report.checks.push(check);
  }
  const secretSource="// Bearer synthetic-canary-token-value\n";
  await assert.rejects(()=>verifyCandidate(secretSource),/candidate_secret_content/);report.checks.push("direct_verifier_secret_rejected_before_staging");
  await assert.rejects(()=>createDiff(secretSource,path.join(directory,"rejected-artifact")),/candidate_secret_content/);report.checks.push("direct_diff_secret_rejected_before_writing");
  report.success=true;
}catch{report.success=false;report.failure="coding_verifier_fixture_failed";process.exitCode=1;}
finally{try{await task.close();report.cleanup_confirmed=true;}catch{report.cleanup_confirmed=false;report.failure??="coding_verifier_cleanup_failed";process.exitCode=1;}report.success=report.success===true&&report.cleanup_confirmed;await writeFile(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");console.log(`Coding verifier: ${report.checks.length} checks, success=${report.success}, cleanup=${report.cleanup_confirmed}`);console.log(`Report: ${path.join(directory,"report.json")}`);}
