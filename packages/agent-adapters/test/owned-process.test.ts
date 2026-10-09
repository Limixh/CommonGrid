import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { CommandError, runOwnedCommand } from "../src/owned-process.ts";

async function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) return false;
    return true;
  } catch (error: any) { if (["ESRCH", "ENOENT"].includes(error.code)) return false; throw error; }
}

test("timeout rejects promptly and stops the owned descendant holding stdout open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-owned-process-"));
  const pidFile = path.join(directory, "child.pid");
  const shutdownFile = path.join(directory, "shutdown"), fixture = randomUUID();
  // This child survives killing just the parent and inherits its output pipes.
  // Both processes also stop through this fixture's unique marker or expiry,
  // even if an assertion fails before we can read the child's identity.
  const descendant = "const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify({fixture:process.argv[3],pid:process.pid}));setTimeout(()=>process.exit(0),20000);setInterval(()=>{if(fs.existsSync(process.argv[1])||!fs.existsSync(require('node:path').dirname(process.argv[1])))process.exit(0);},50);";
  const source = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[2],process.argv[1],process.argv[3]],{stdio:['ignore',1,2]});setTimeout(()=>process.exit(0),20000);setInterval(()=>{if(fs.existsSync(process.argv[2])||!fs.existsSync(require('node:path').dirname(process.argv[2])))process.exit(0);},50);`;
  let pid: number | undefined;
  try {
    const started = Date.now();
    const running = runOwnedCommand(process.execPath, ["-e", source, pidFile, shutdownFile, fixture], { timeoutMs: 1800 });
    let failure: CommandError | undefined;
    await assert.rejects(running, error => {
      assert.ok(error instanceof CommandError); assert.equal(error.message, "docker_timeout"); failure = error; return true;
    });
    assert.ok(Date.now() - started < 4500, "inherited pipes must not postpone rejection");
    const cleanupStarted = Date.now(), cleanup = await failure!.cleanup;
    assert.ok(Date.now() - cleanupStarted < 6500, "cleanup evidence must have a bounded completion");
    assert.equal(cleanup.status, "termination_reported", "termination helper/root outcome must be observed separately");
    assert.equal(cleanup.method, process.platform === "win32" ? "windows_taskkill" : "posix_process_group");
    if (process.platform === "win32") assert.equal(cleanup.helperExitCode, 0);
    const identity = JSON.parse(await readFile(pidFile, "utf8"));
    assert.equal(identity.fixture, fixture);
    pid = Number(identity.pid);
    assert.ok(Number.isInteger(pid) && pid > 0);
    let alive = true;
    for (let i = 0; i < 40; i++) {
      alive = await processAlive(pid);
      if (!alive) break;
      await delay(100);
    }
    assert.equal(alive, false, "owned child must no longer be running");
  } finally {
    // Never kill a bare PID that may have been reused. The marker targets only
    // this fixture and works even when no PID was assigned in the test process.
    await writeFile(shutdownFile, fixture);
    try {
      if (!pid) {
        try {
          const identity = JSON.parse(await readFile(pidFile, "utf8"));
          if (identity.fixture === fixture && Number.isInteger(identity.pid) && identity.pid > 0) pid = identity.pid;
        } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
      if (pid) {
        const deadline = Date.now() + 2000;
        while (await processAlive(pid)) {
          assert.ok(Date.now() < deadline, "fixture shutdown marker must stop its observed child");
          await delay(50);
        }
      } else await delay(150); // No observed child identity; finite expiry remains the final bound.
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("trusted stdin delivery preserves bytes and output remains bounded", async () => {
  const input = Buffer.from([0, 255, 128, 10, 13, 34, 36]);
  const result = await runOwnedCommand(process.execPath, ["-e", "const a=[];process.stdin.on('data',x=>a.push(x));process.stdin.on('end',()=>console.log(Buffer.concat(a).toString('hex')));"], { stdin: Readable.from([input]) });
  assert.equal(result.stdout.trim(), input.toString("hex"));
  await assert.rejects(runOwnedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);"], { maxBytes: 1024 }), /docker_output_limit/);
});
