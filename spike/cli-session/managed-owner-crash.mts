// Real host-owner termination against newly prepared synthetic profiles only.
// This accepts explicit stopped-operation recovery, not automatic crash takeover.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedCliRuntime, checked, assertManagedContainerFence, removeManagedOperationContainer, type ManagedContainerEvidence } from "./managed-runtime.mts";
import { failureCode } from "../../packages/agent-adapters/src/session-protocol.ts";
import { readOperationJournals } from "../../packages/agent-adapters/src/operation-journal.ts";

type Provider = "claude" | "codex";
interface Ready { kind: "ready"; provider: Provider; owner: string; operation: string; lease_id: string; containerId: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const journalRoot = fileURLToPath(new URL("../../.local/managed-operation-journal/", import.meta.url));
async function operationJournal(receipt: Ready) {
  const inspection = await readOperationJournals(journalRoot, { maxOperations: 4096 });
  assert.equal(inspection.status, "available", "managed_owner_crash_journal_unavailable");
  const matches = inspection.operations.filter(value => value.identity.owner === receipt.owner && value.identity.provider === receipt.provider && value.identity.operation === receipt.operation);
  assert.equal(matches.length, 1, "managed_owner_crash_journal_identity_mismatch");
  const snapshot = matches[0];
  assert.equal(snapshot.lease_id, receipt.lease_id, "managed_owner_crash_journal_lease_mismatch");
  assert.ok(snapshot.namespace_ids.includes(receipt.containerId), "managed_owner_crash_journal_namespace_missing");
  assert.equal(snapshot.terminal, false, "managed_owner_crash_journal_false_completion");
  return snapshot;
}
const evidenceFormat = '{"id":{{json .Id}},"owner":{{json (index .Config.Labels "io.commongrid.spike.owner")}},"operation":{{json (index .Config.Labels "io.commongrid.spike.operation")}},"running":{{json .State.Running}},"status":{{json .State.Status}}}';
function readyMessage(value: unknown, provider: Provider, owner: string): Ready {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "managed_owner_crash_worker_protocol");
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["kind", "provider", "owner", "operation", "lease_id", "containerId"].sort(), "managed_owner_crash_worker_protocol");
  assert.ok(record.kind === "ready" && record.provider === provider && record.owner === owner && typeof record.operation === "string" && uuid.test(record.operation) && typeof record.lease_id === "string" && /^[a-f0-9]{64}$/.test(record.lease_id) && typeof record.containerId === "string" && /^[a-f0-9]{64}$/.test(record.containerId), "managed_owner_crash_worker_protocol");
  return record as unknown as Ready;
}
async function inspectOwned(receipt: Ready, requireStopped = false) {
  const evidence: unknown = JSON.parse(await checked(["inspect", "--format", evidenceFormat, receipt.containerId], 5000));
  assertManagedContainerFence(evidence, receipt.owner, receipt.operation, requireStopped);
  assert.equal(evidence.id, receipt.containerId, "managed_container_id_mismatch");
  return evidence as ManagedContainerEvidence;
}
async function absent(id: string) {
  return !(await checked(["container", "ls", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], 5000)).split(/\r?\n/).includes(id);
}
async function ownedProbe(receipt: Ready, script: string) {
  assert.equal((await inspectOwned(receipt)).running, true, "managed_owner_crash_orphan_not_running");
  return checked(["exec", receipt.containerId, "node", "-e", script], 5000);
}
function workerReady(child: ChildProcess, provider: Provider, owner: string, onOwnership: (value:{operation:string;lease_id:string}) => void) {
  return new Promise<Ready>((resolve, reject) => {
    let operation: string | undefined, leaseId: string | undefined;
    const finish = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error); };
    const message = (value: unknown) => {
      try {
        if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "ownership") {
          const record = value as Record<string, unknown>;
          assert.deepEqual(Object.keys(record).sort(), ["kind", "provider", "owner", "operation", "lease_id"].sort());
          assert.ok(!operation && record.provider === provider && record.owner === owner && typeof record.operation === "string" && uuid.test(record.operation) && typeof record.lease_id === "string" && /^[a-f0-9]{64}$/.test(record.lease_id));
          operation = record.operation; leaseId = record.lease_id; onOwnership({operation,lease_id:leaseId}); return;
        }
        const receipt = readyMessage(value, provider, owner);
        assert.equal(receipt.operation, operation);
        assert.equal(receipt.lease_id, leaseId);
        finish(); resolve(receipt);
      } catch { finish(); reject(new Error("managed_owner_crash_worker_protocol")); }
    };
    const exit = () => { finish(); reject(new Error("managed_owner_crash_worker_early_exit")); };
    const error = () => { finish(); reject(new Error("managed_owner_crash_worker_start_failed")); };
    const timer = setTimeout(() => { finish(); reject(new Error("managed_owner_crash_worker_ready_deadline")); }, 45_000);
    child.on("message", message); child.once("exit", exit); child.once("error", error);
  });
}
async function separateProcessRefusal(provider: Provider, owner: string) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("managed-owner-crash-worker.mts", import.meta.url)), provider, owner, "contender"], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", error); };
      const message = (value: unknown) => { finish(); try { assert.deepEqual(value, { kind: "refused", code: "managed_profile_busy" }); resolve(); } catch { reject(new Error("managed_owner_crash_contender_not_refused")); } };
      const exit = () => { finish(); reject(new Error("managed_owner_crash_contender_early_exit")); };
      const error = () => { finish(); reject(new Error("managed_owner_crash_contender_start_failed")); };
      const timer = setTimeout(() => { finish(); reject(new Error("managed_owner_crash_contender_deadline")); }, 30_000);
      child.on("message", message); child.once("exit", exit); child.once("error", error);
    });
  } finally { await forceWorkerExit(child); }
}
async function forceWorkerExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); child.off("exit", exit); };
    const exit = () => { finish(); resolve(); };
    const timer = setTimeout(() => { finish(); reject(new Error("managed_owner_crash_worker_exit_deadline")); }, 5000);
    child.once("exit", exit);
    if (!child.kill("SIGKILL")) { finish(); reject(new Error("managed_owner_crash_worker_kill_failed")); }
  });
}

export async function managedOwnerCrashMain(args = process.argv.slice(2)) {
  assert.ok(args.every(value => value === "claude" || value === "codex"), "managed_owner_crash_provider_invalid");
  const providers = args.length ? [...new Set(args)] as Provider[] : ["claude", "codex"] as Provider[];
  const directory = fileURLToPath(new URL(`../../.local/managed-owner-crash/${randomUUID()}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  const report: Record<string, any> = { checked_at: new Date().toISOString(), purpose: "synthetic_host_owner_crash_durable_claim_and_phase_journal_explicit_recovery", synthetic_profiles_only: true, existing_private_profiles_accessed: false, real_account_tested: false, real_model_inference: false, credential_files_copied: false, execution_enabled: false, isolation_gate: "not_evaluated", durable_f0_profile_claim_accepted: false, process_crash_journal_observed: false, automatic_crash_recovery_accepted: false, production_profile_lock_accepted: false, providers: {}, cleanup_confirmed: false, scope_limits: ["forced death of a dedicated synthetic Node owner after successful start only", "explicit immutable-ID stop and stopped-operation reconciliation with manual owner-quiescence acknowledgment; no automatic live takeover", "journal persists intent and captured IDs across host-process death; it does not prove owner quiescence, current daemon state, Windows power-loss persistence or automatic recovery", "daemon loss and real interrupted-create lost-ID acceptance remain pending", "pinned Docker Linux runtime on the current host only"] };
  let cleanup = true;
  for (const provider of providers) {
    const checks: string[] = [], evidence: Record<string, any> = { status: "running", checks };
    report.providers[provider] = evidence;
    let prepared: ManagedCliRuntime | undefined, child: ChildProcess | undefined, currentRuntime: ManagedCliRuntime | undefined, receipt: Ready | undefined;
    let validatedReady = false;
    let stage = "fresh_synthetic_prepare";
    try {
      prepared = await ManagedCliRuntime.prepare(provider);
      evidence.synthetic_owner = prepared.owner;
      await prepared.finishOperation();
      stage = "dedicated_owner_ready";
      child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("managed-owner-crash-worker.mts", import.meta.url)), provider, prepared.owner], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      receipt = await workerReady(child, provider, prepared.owner, claim => { evidence.ownership_receipt_before_start = true; evidence.synthetic_operation = claim.operation; evidence.synthetic_lease_id = claim.lease_id; });
      validatedReady = true;
      stage = "separate_process_claim_exclusion";
      const processClaims = await Promise.allSettled([separateProcessRefusal(provider, prepared.owner), separateProcessRefusal(provider, prepared.owner)]);
      assert.ok(processClaims.every(result => result.status === "fulfilled"), "managed_owner_crash_process_claim_exclusion_failed");
      checks.push("two_separate_host_process_claims_refused_by_durable_profile_ownership");
      const heartbeatScript = "console.log(require('node:fs').readFileSync('/home/node/cg-owner-crash-heartbeat','utf8'))";
      const before = Number(await ownedProbe(receipt, heartbeatScript));
      assert.ok(Number.isSafeInteger(before) && before > 0, "managed_owner_crash_heartbeat_invalid");
      const journalBeforeDeath = await operationJournal(receipt);
      stage = "force_host_owner_death";
      await forceWorkerExit(child);
      assert.ok(child.exitCode !== null || child.signalCode !== null, "managed_owner_crash_worker_still_running");
      await pause(250);
      const after = Number(await ownedProbe(receipt, heartbeatScript));
      assert.ok(Number.isSafeInteger(after) && after > before, "managed_owner_crash_descendant_not_observed");
      checks.push("forced_host_owner_exit_leaves_live_owned_namespace_and_descendant");
      const journalAfterDeath = await operationJournal(receipt);
      assert.equal(journalAfterDeath.last_sequence, journalBeforeDeath.last_sequence, "managed_owner_crash_journal_changed_after_death");
      assert.equal(journalAfterDeath.last_hash, journalBeforeDeath.last_hash, "managed_owner_crash_journal_changed_after_death");
      evidence.journal_revision_after_owner_death = journalAfterDeath.last_sequence;
      evidence.journal_durability = journalAfterDeath.durability;
      evidence.journal_does_not_authorize_takeover = true;
      checks.push("phase_journal_preserves_exact_ownership_receipts_after_host_owner_death");
      stage = "live_orphan_refuses_takeover";
      const recovery = ManagedCliRuntime.restore(prepared.identity());
      await assert.rejects(() => recovery.start(), /managed_profile_busy/);
      const recoveryReceipt = { operation: receipt.operation, lease_id: receipt.lease_id, owner_quiesced: true as const };
      await assert.rejects(() => recovery.recoverStopped(recoveryReceipt), /managed_recovery_requires_stopped/);
      await assert.rejects(() => recovery.installTrustBundle(), /managed_profile_busy/);
      await assert.rejects(() => recovery.destroy(), /managed_profile_busy/);
      await recovery.stop();
      assert.equal((await inspectOwned(receipt)).running, true);
      checks.push("new_operation_start_recovery_and_cleanup_preserve_live_orphan");
      stage = "explicit_stopped_exact_operation_reconciliation";
      assert.equal(await ownedProbe(receipt, "const f=require('node:fs');if(f.existsSync('/home/node/cg-owner-crash-late-write'))process.exit(1);f.writeFileSync('/home/node/cg-owner-crash-arm','synthetic',{flag:'wx',mode:0o600});console.log(true)"), "true");
      const armDeadline = Date.now() + 5000;
      while (await ownedProbe(receipt, "console.log(require('node:fs').existsSync('/home/node/cg-owner-crash-child-armed'))") !== "true") {
        assert.ok(Date.now() < armDeadline, "managed_owner_crash_arm_deadline"); await pause(50);
      }
      const acknowledgedAt = Number(await ownedProbe(receipt, "console.log(require('node:fs').readFileSync('/home/node/cg-owner-crash-child-armed','utf8'))"));
      assert.ok(Number.isSafeInteger(acknowledgedAt) && acknowledgedAt > 0, "managed_owner_crash_arm_invalid");
      // The descendant has positively acknowledged its timer. Use host elapsed
      // time from that observation, avoiding container/host wall-clock skew.
      const lateWriteDeadline = Date.now() + 12_500;
      assert.equal(await ownedProbe(receipt, "const f=require('node:fs');console.log(Date.now()<Number(f.readFileSync('/home/node/cg-owner-crash-child-armed','utf8'))+12000&&!f.existsSync('/home/node/cg-owner-crash-late-write'))"), "true");
      await checked(["stop", "--time", "1", receipt.containerId], 10_000);
      await inspectOwned(receipt, true);
      await assert.rejects(() => recovery.recoverStopped({ ...recoveryReceipt, operation: randomUUID() }));
      await assert.rejects(() => recovery.recoverStopped({ ...recoveryReceipt, lease_id: "f".repeat(64) }));
      assert.equal(await absent(receipt.containerId), false);
      const recovered = await recovery.recoverStopped(recoveryReceipt);
      assert.equal(recovered.recovered_containers, 1); assert.equal(recovered.private_volumes_retained, true);
      assert.equal(await absent(receipt.containerId), true);
      assert.equal(await absent(receipt.lease_id), true); currentRuntime = recovery;
      await recovery.beginOperation();
      await recovery.verify("volume", recovery.authVolume); await recovery.verify("volume", recovery.toolsVolume);
      checks.push("wrong_operation_refused_and_exact_stopped_operation_removed_with_volumes_retained");
      stage = "synthetic_state_retained_and_successor_fenced";
      await recovery.start();
      const canaryScript = "console.log(require('node:fs').readFileSync('/home/node/cg-owner-crash-canary','utf8')==='CG_OWNER_CRASH_SYNTHETIC')";
      assert.equal((await recovery.exec(["node", "-e", canaryScript])).stdout.trim(), "true");
      await recovery.stop();
      const heldLease = recovery.leaseIdentity(); assert.ok(heldLease);
      await assert.rejects(() => ManagedCliRuntime.restore(prepared!.identity()).start(), /managed_profile_busy/);
      await recovery.finishOperation();
      const successor = ManagedCliRuntime.restore(prepared.identity()); currentRuntime = successor; await successor.start();
      const successorId = await successor.verifyOperation();
      await recovery.stop(); await assert.rejects(() => recovery.exec(["/bin/true"]));
      await recovery.finishOperation();
      await assert.rejects(() => recovery.recoverStopped(recoveryReceipt));
      await removeManagedOperationContainer(receipt.containerId, receipt.owner, receipt.operation);
      assert.equal(await successor.verifyOperation(), successorId);
      assert.ok(successor.leaseIdentity(), "managed_owner_crash_successor_lease_missing");
      assert.equal((await successor.exec(["node", "-e", canaryScript])).stdout.trim(), "true");
      checks.push("synthetic_private_state_retained_and_stale_cleanup_preserves_successor");
      stage = "removed_descendant_cannot_write_later";
      await pause(Math.max(0, lateWriteDeadline - Date.now()));
      assert.equal((await successor.exec(["node", "-e", "console.log(!require('node:fs').existsSync('/home/node/cg-owner-crash-late-write'))"])).stdout.trim(), "true");
      checks.push("namespace_stop_terminates_orphan_descendant_before_delayed_write");
      evidence.status = "passed"; console.log(`PASS ${provider}: ${checks.length} synthetic owner-crash groups`);
    } catch (error) {
      evidence.status = "failed"; evidence.failed_stage = stage; evidence.failure = failureCode(error, "managed_owner_crash_validation_failed");
      if (error instanceof Error && error.message === "managed_prepare_cleanup_unconfirmed") cleanup = false;
      process.exitCode = 1; console.log(`FAIL ${provider}: ${stage}`);
    } finally {
      if (child && !validatedReady) {
        // A killed create client can hide a daemon mutation that finishes after
        // our best-effort cleanup. A single absence listing cannot prove it away.
        evidence.cleanup_uncertain_before_ready = true; cleanup = false; process.exitCode = 1;
      }
      let workerExited = true;
      if (child) { try { await forceWorkerExit(child); } catch { workerExited = false; cleanup = false; process.exitCode = 1; } }
      // If the worker cannot be confirmed dead, retain this new profile rather
      // than race an unresolved creator against volume destruction.
      if (prepared && workerExited) {
        try {
          if (!currentRuntime && receipt && !await absent(receipt.lease_id)) {
            const old = await inspectOwned(receipt);
            if (old.running) await checked(["stop", "--time", "1", receipt.containerId], 10_000);
            currentRuntime = ManagedCliRuntime.restore(prepared.identity());
            await currentRuntime.recoverStopped({ operation: receipt.operation, lease_id: receipt.lease_id, owner_quiesced: true });
          }
          await currentRuntime?.finishOperation();
          await ManagedCliRuntime.restore(prepared.identity()).destroy();
          for (const name of [prepared.container, `cg-managed-init-${prepared.owner}`]) assert.equal(await checked(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], 5000), "");
          assert.equal(await checked(["container", "ls", "--all", "--filter", `name=^/cg-managed-lease-${prepared.owner}$`, "--format", "{{.Names}}"],5000),"");
          for (const volume of [prepared.authVolume, prepared.toolsVolume]) assert.ok(!(await checked(["volume", "ls", "--filter", `name=${volume}`, "--format", "{{.Name}}"], 5000)).split(/\r?\n/).includes(volume));
        } catch { cleanup = false; process.exitCode = 1; }
      }
    }
  }
  report.cleanup_confirmed = cleanup;
  report.success = cleanup && providers.every(provider => report.providers[provider].status === "passed");
  report.durable_f0_profile_claim_accepted = report.success;
  report.process_crash_journal_observed = report.success;
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${path.join(directory, "report.json")}`);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) managedOwnerCrashMain().catch(error => { console.error(failureCode(error)); process.exitCode = 1; });
