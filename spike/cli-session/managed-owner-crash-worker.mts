// Dedicated synthetic owner process. The acceptance parent deliberately kills
// it without cooperative cleanup; no provider CLI or credential file is opened.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ManagedCliRuntime } from "./managed-runtime.mts";

export async function ownerCrashWorker(args = process.argv.slice(2)) {
  const [provider, owner, mode] = args;
  assert.ok((args.length === 2 || (args.length === 3 && mode === "contender")) && (provider === "claude" || provider === "codex") && process.send, "managed_owner_crash_worker_args_invalid");
  const runtime = ManagedCliRuntime.restore({ owner, provider });
  if (mode === "contender") {
    try { await runtime.beginOperation(); await runtime.finishOperation(); }
    catch (error) {
      if (error instanceof Error && /^(?:managed_profile_busy|profile_lease_busy)$/.test(error.message)) {
        await new Promise<void>((resolve, reject) => process.send!({ kind: "refused", code: "managed_profile_busy" }, (failure: Error | null) => failure ? reject(failure) : resolve()));
        process.disconnect?.(); return;
      }
      throw error;
    }
    throw new Error("managed_owner_crash_contender_acquired");
  }
  await runtime.beginOperation();
  const lease = runtime.leaseIdentity(); assert.ok(lease, "managed_owner_crash_lease_missing");
  await new Promise<void>((resolve, reject) => process.send!({ kind: "ownership", provider, owner, operation: lease.operation, lease_id: lease.lease_id }, (error: Error | null) => error ? reject(new Error("managed_owner_crash_ipc_failed")) : resolve()));
  await runtime.start();
  const containerId = await runtime.verifyOperation();
  const descendant = "const f=require('node:fs');f.writeFileSync('/home/node/cg-owner-crash-child-ready','synthetic',{flag:'wx',mode:0o600});const tick=()=>f.writeFileSync('/home/node/cg-owner-crash-heartbeat',String(Date.now()),{mode:0o600});let armed=false;tick();setInterval(()=>{tick();if(!armed&&f.existsSync('/home/node/cg-owner-crash-arm')){armed=true;setTimeout(()=>f.writeFileSync('/home/node/cg-owner-crash-late-write','forbidden',{flag:'wx',mode:0o600}),12000);f.writeFileSync('/home/node/cg-owner-crash-child-armed',String(Date.now()),{flag:'wx',mode:0o600});}},100);";
  const start = await runtime.exec(["node", "-e", `const f=require('node:fs');f.writeFileSync('/home/node/cg-owner-crash-canary','CG_OWNER_CRASH_SYNTHETIC',{flag:'wx',mode:0o600});const child=require('node:child_process').spawn('node',['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});child.unref();`]);
  assert.equal(start.code, 0, "managed_owner_crash_child_start_failed");
  const deadline = Date.now() + 5000;
  while (true) {
    const ready = await runtime.exec(["node", "-e", "const f=require('node:fs');console.log(f.existsSync('/home/node/cg-owner-crash-child-ready')&&f.existsSync('/home/node/cg-owner-crash-heartbeat'))"], 2000);
    assert.equal(ready.code, 0, "managed_owner_crash_child_probe_failed");
    if (ready.stdout.trim() === "true") break;
    assert.ok(Date.now() < deadline, "managed_owner_crash_child_ready_deadline");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  process.send!({ kind: "ready", provider, owner, operation: lease.operation, lease_id: lease.lease_id, containerId });
  // No live Docker client remains when ready is emitted. The detached Node
  // descendant belongs to the synthetic container and survives owner death.
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ownerCrashWorker().catch(() => {
    process.send?.({ kind: "failed", code: "managed_owner_crash_worker_failed" });
    process.exitCode = 1;
    process.disconnect?.();
  });
}
