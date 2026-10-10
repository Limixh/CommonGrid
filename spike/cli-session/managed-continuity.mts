// Same-profile runtime continuity with new synthetic profiles only. This does
// not exercise provider account concurrency, refresh, entitlement or quotas.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedCliRuntime, checked, startBridge } from "./managed-runtime.mts";
import { attachManagedControl } from "./managed-control.mts";

const selected = process.argv.slice(2);
assert.ok(selected.every(value => value === "claude" || value === "codex"), "managed_continuity_provider_invalid");
const providers = selected.length ? [...new Set(selected)] as ("claude" | "codex")[] : ["claude", "codex"] as const;
const directory = fileURLToPath(new URL(`../../.local/managed-continuity/${randomUUID()}/`, import.meta.url));
await mkdir(directory, { recursive: true });
const report: Record<string, any> = { checked_at: new Date().toISOString(), purpose: "synthetic_same_profile_runtime_continuity", synthetic_profiles_only: true, existing_private_profiles_accessed: false, real_account_tested: false, real_model_inference: false, credential_files_copied: false, execution_enabled: false, isolation_gate: "not_evaluated", durable_f0_profile_claim_accepted: false, providers: {}, cleanup_confirmed: false, scope_limits: ["same-profile runtime commands only; real provider concurrency/quotas not accepted", "explicit stopped-operation reconciliation requires validated zero-pending old journal and manual owner-quiescence acknowledgment; automatic crash detection/recovery not accepted", "runtime journal does not accept packaged native launch, Windows power-loss persistence or automatic recovery", "host/daemon failure during cleanup still requires ownership-verified reconciliation", "pinned Linux Docker host setup only"] };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { if (await predicate()) return; await pause(50); }
  throw new Error("managed_continuity_wait_deadline");
}
async function containerAbsent(id: string) { return !(await checked(["container", "ls", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"])).split(/\r?\n/).includes(id); }
let cleanup = true;
for (const provider of providers) {
  const checks: string[] = []; const evidence: Record<string, any> = { status: "running", checks }; report.providers[provider] = evidence;
  let prepared: ManagedCliRuntime | undefined, runtime: ManagedCliRuntime | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined, silent: ReturnType<typeof attachManagedControl> | undefined;
  let interrupted: Promise<unknown> | undefined, cancellation: AbortController | undefined;
  let stage = "fresh_synthetic_prepare";
  try {
    prepared = await ManagedCliRuntime.prepare(provider); runtime = prepared; await runtime.start();
    const canary = `CG_CONTINUITY_SYNTHETIC_${randomUUID()}`;
    const assertCanary = async () => {
      assert.ok(runtime); const result = await runtime.exec(["node", "-e", `console.log(require('node:fs').readFileSync('/home/node/cg-continuity-canary','utf8')===${JSON.stringify(canary)})`]); assert.equal(result.code, 0); assert.equal(result.stdout.trim(), "true");
    };
    assert.equal((await runtime.exec(["node", "-e", `require('node:fs').writeFileSync('/home/node/cg-continuity-canary',${JSON.stringify(canary)},{flag:'wx',mode:0o600})`])).code, 0);
    const incumbentId = await runtime.verifyOperation(), incumbentLease = runtime.leaseIdentity(); assert.ok(incumbentLease);
    const incumbentOperation = incumbentLease.operation;
    const incumbentReceipt = { operation: incumbentOperation, lease_id: incumbentLease.lease_id, owner_quiesced: true as const };
    stage = "competing_start_fence";
    const contenders = Array.from({ length: 6 }, () => ManagedCliRuntime.restore(runtime!.identity()));
    const starts = await Promise.allSettled(contenders.map(contender => contender.start())); assert.ok(starts.every(result => result.status === "rejected"));
    await Promise.all(contenders.map(contender => contender.stop())); assert.equal(await runtime.verifyOperation(), incumbentId); await assertCanary();
    evidence.competing_starts_rejected = starts.length; checks.push("six_competing_starts_and_cleanup_preserve_incumbent");
    stage = "competing_exec_and_control_fence";
    await assert.rejects(() => contenders[0].exec(["node", "-e", "require('node:fs').writeFileSync('/home/node/cg-contender-write','forbidden')"]));
    await assert.rejects(() => startBridge(contenders[0]));
    assert.equal((await runtime.exec(["node", "-e", "console.log(require('node:fs').existsSync('/home/node/cg-contender-write'))"])).stdout.trim(), "false"); checks.push("wrong_operation_exec_and_bridge_cannot_dispatch");
    stage = "live_recovery_refused";
    await assert.rejects(() => contenders[0].recoverStopped(incumbentReceipt)); assert.equal(await runtime.verifyOperation(), incumbentId); checks.push("reference_recovery_refuses_running_owned_namespace");
    stage = "private_state_restart";
    await runtime.stop(); assert.equal(await containerAbsent(incumbentId), true);
    assert.deepEqual(runtime.leaseIdentity(), incumbentLease);
    await assert.rejects(() => contenders[0].installTrustBundle(), /managed_profile_busy/);
    await assert.rejects(() => contenders[0].destroy(), /managed_profile_busy/);
    await runtime.start(); assert.deepEqual(runtime.leaseIdentity(), incumbentLease); await assertCanary(); checks.push("same_operation_restart_retains_fake_private_state_and_durable_exclusive_claim");
    stage = "stopped_operation_reconciliation";
    const stoppedId = await runtime.verifyOperation(); await checked(["stop", "--time", "1", stoppedId]);
    const recoveredRuntime = ManagedCliRuntime.restore(runtime.identity());
    await assert.rejects(() => recoveredRuntime.recoverStopped({ ...incumbentReceipt, operation: randomUUID() })); assert.equal(await containerAbsent(stoppedId), false);
    const reconciled = await recoveredRuntime.recoverStopped(incumbentReceipt);
    assert.equal(reconciled.recovered_containers, 1); assert.equal(reconciled.private_volumes_retained, true); assert.equal(await containerAbsent(stoppedId), true);
    assert.equal(await containerAbsent(incumbentLease.lease_id), true);
    await recoveredRuntime.beginOperation();
    await recoveredRuntime.verify("volume", recoveredRuntime.authVolume); await recoveredRuntime.verify("volume", recoveredRuntime.toolsVolume);
    const staleRuntime = runtime; runtime = recoveredRuntime; await runtime.start(); await assertCanary();
    const successorId = await runtime.verifyOperation(); await staleRuntime.stop(); await assert.rejects(() => staleRuntime.exec(["/bin/true"]));
    await assert.rejects(() => staleRuntime.recoverStopped(incumbentReceipt)); assert.equal(await runtime.verifyOperation(), successorId); checks.push("stopped_exact_operation_reconciled_and_stale_cleanup_preserves_successor");
    stage = "interrupted_owned_exec";
    cancellation = new AbortController();
    const delayedChild = "const f=require('node:fs');process.title='cg-continuity-delayed-child';f.writeFileSync('/home/node/cg-interrupted-child-started','synthetic');setTimeout(()=>f.writeFileSync('/home/node/cg-interrupted-late-write','forbidden'),10000);setInterval(()=>{},1000)";
    interrupted = runtime.exec(["node", "-e", `const f=require('node:fs'),cp=require('node:child_process');f.writeFileSync('/home/node/cg-interrupted-started','synthetic');const child=cp.spawn('node',['-e',${JSON.stringify(delayedChild)}],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`], 30_000, { signal: cancellation.signal }); interrupted.catch(() => {});
    await waitUntil(async () => { assert.ok(runtime); const probeId = await runtime.verifyOperation(); return await checked(["exec",probeId,"node","-e","console.log(require('node:fs').existsSync('/home/node/cg-interrupted-child-started'))"],3000) === "true"; });
    const canceledWriteDeadline = performance.now() + 10_500;
    const cancelStart = performance.now(); cancellation.abort(); await assert.rejects(interrupted, /docker_cancelled/); interrupted = undefined;
    assert.equal(await containerAbsent(successorId), true); evidence.interrupted_exec_cleanup_ms = Math.round(performance.now() - cancelStart); assert.ok(evidence.interrupted_exec_cleanup_ms < 20_000);
    const interruptedRuntime = runtime; await interruptedRuntime.finishOperation(); runtime = ManagedCliRuntime.restore(runtime.identity()); await runtime.start(); await assertCanary();
    await interruptedRuntime.stop(); await pause(Math.max(0, canceledWriteDeadline - performance.now()));
    assert.equal((await runtime.exec(["node", "-e", "console.log(!require('node:fs').existsSync('/home/node/cg-interrupted-late-write'))"])).stdout.trim(), "true"); checks.push("canceled_exec_removes_owned_namespace_descendants_and_preserves_new_operation");
    stage = "timed_out_owned_exec";
    const timedOutId = await runtime.verifyOperation();
    const timeoutChild = "const f=require('node:fs');process.title='cg-continuity-timeout-child';f.writeFileSync('/home/node/cg-timeout-child-started',String(Date.now()));setTimeout(()=>f.writeFileSync('/home/node/cg-timeout-late-write','forbidden'),10000);setInterval(()=>{},1000)";
    const timeoutStart = performance.now();
    await assert.rejects(() => runtime!.exec(["node", "-e", `const child=require('node:child_process').spawn('node',['-e',${JSON.stringify(timeoutChild)}],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`], 6000), /docker_timeout/);
    evidence.timed_out_exec_cleanup_ms = Math.round(performance.now() - timeoutStart); assert.ok(evidence.timed_out_exec_cleanup_ms < 20_000);
    assert.equal(await containerAbsent(timedOutId), true);
    await runtime.verify("volume", runtime.authVolume); await runtime.verify("volume", runtime.toolsVolume);
    const timedOutRuntime = runtime; await timedOutRuntime.finishOperation(); runtime = ManagedCliRuntime.restore(runtime.identity()); await runtime.start(); await assertCanary();
    const childStarted = Number((await runtime.exec(["node", "-e", "console.log(require('node:fs').readFileSync('/home/node/cg-timeout-child-started','utf8'))"])).stdout.trim());
    assert.ok(Number.isSafeInteger(childStarted) && childStarted > 0 && childStarted <= Date.now());
    await timedOutRuntime.stop(); await pause(Math.max(0, childStarted + 10_500 - Date.now()));
    assert.equal((await runtime.exec(["node", "-e", "console.log(!require('node:fs').existsSync('/home/node/cg-timeout-late-write'))"])).stdout.trim(), "true"); checks.push("timed_out_exec_removes_owned_namespace_descendants_and_retains_private_volumes");
    stage = "interrupted_control_path";
    bridge = await startBridge(runtime); bridge.child.kill(); await waitUntil(() => bridge!.stats.control_failure, 10_000);
    const controlInterruptedId = await runtime.verifyOperation(); const outsider = ManagedCliRuntime.restore(runtime.identity()); await outsider.stop(); assert.equal(await runtime.verifyOperation(), controlInterruptedId);
    bridge.close(); bridge = undefined; await runtime.finishOperation(); assert.equal(await containerAbsent(controlInterruptedId), true);
    runtime = ManagedCliRuntime.restore(runtime.identity()); await runtime.start(); await assertCanary();
    bridge = await startBridge(runtime); assert.equal(bridge.stats.control_failure, false); bridge.close(); bridge = undefined; checks.push("unexpected_control_exit_observed_and_owned_namespace_explicitly_reconciled");
    stage = "bounded_readiness_failure";
    const silentId = await runtime.verifyOperation();
    const child = spawn("docker", ["exec", "-i", silentId, "node", "-e", "require('node:fs').writeFileSync('/home/node/cg-silent-control-started','synthetic');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const readinessStart = performance.now(); silent = attachManagedControl(child, { provider, readyTimeoutMs: 3000 });
    await assert.rejects(silent.ready, /managed_bridge_deadline/); evidence.readiness_failure_ms = Math.round(performance.now() - readinessStart); assert.ok(evidence.readiness_failure_ms < 6000);
    assert.equal((await runtime.exec(["node", "-e", "console.log(require('node:fs').existsSync('/home/node/cg-silent-control-started'))"])).stdout.trim(), "true"); silent.close(); silent = undefined;
    await runtime.finishOperation(); assert.equal(await containerAbsent(silentId), true); runtime = ManagedCliRuntime.restore(runtime.identity()); await runtime.start(); await assertCanary(); checks.push("silent_real_docker_control_has_bounded_readiness_and_explicit_recovery");
    evidence.status = "passed"; console.log(`PASS ${provider}: ${checks.length} synthetic runtime continuity groups`);
  } catch (error) {
    if (error instanceof Error && error.message === "managed_prepare_cleanup_unconfirmed") cleanup = false;
    evidence.status = "failed"; evidence.failed_stage = stage; process.exitCode = 1; console.log(`FAIL ${provider}: ${stage}`);
  }
  finally {
    cancellation?.abort(); bridge?.close(); silent?.close();
    if (interrupted) { try { await interrupted; } catch {} }
    if (prepared) {
      try {
        await runtime?.finishOperation(); await ManagedCliRuntime.restore(prepared.identity()).destroy();
        for (const name of [prepared.container,`cg-managed-init-${prepared.owner}`,`cg-managed-lease-${prepared.owner}`]) assert.equal(await checked(["container","ls","--all","--filter",`name=^/${name}$`,"--format","{{.Names}}"]),"");
        for (const volume of [prepared.authVolume, prepared.toolsVolume]) assert.ok(!(await checked(["volume", "ls", "--filter", `name=${volume}`, "--format", "{{.Name}}"])).split(/\r?\n/).includes(volume));
      }
      catch { cleanup = false; process.exitCode = 1; }
    }
  }
}
report.cleanup_confirmed = cleanup; report.success = cleanup && providers.every(provider => report.providers[provider].status === "passed");
report.durable_f0_profile_claim_accepted = report.success;
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n"); console.log(`Report: ${path.join(directory, "report.json")}`);
