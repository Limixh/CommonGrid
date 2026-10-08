import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { runOwnedCommand } from "../src/owned-process.ts";

test("timeout rejects promptly and stops the owned descendant holding stdout open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-owned-process-"));
  const pidFile = path.join(directory, "child.pid");
  // This child survives killing just the parent and inherits its output pipes.
  const source = "const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
  let pid: number | undefined;
  try {
    const started = Date.now();
    const running = runOwnedCommand(process.execPath, ["-e", source, pidFile], { timeoutMs: 1800 });
    await assert.rejects(running, /docker_timeout/);
    assert.ok(Date.now() - started < 4500, "inherited pipes must not postpone rejection");
    pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    let alive = true;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
        if (process.platform !== "win32" && /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) alive = false;
      } catch (error: any) { if (["ESRCH", "ENOENT"].includes(error.code)) alive = false; else throw error; }
      if (!alive) break;
      await delay(100);
    }
    assert.equal(alive, false, "owned child must no longer be running");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted stdin delivery preserves bytes and output remains bounded", async () => {
  const input = Buffer.from([0, 255, 128, 10, 13, 34, 36]);
  const result = await runOwnedCommand(process.execPath, ["-e", "const a=[];process.stdin.on('data',x=>a.push(x));process.stdin.on('end',()=>console.log(Buffer.concat(a).toString('hex')));"], { stdin: Readable.from([input]) });
  assert.equal(result.stdout.trim(), input.toString("hex"));
  await assert.rejects(runOwnedCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);"], { maxBytes: 1024 }), /docker_output_limit/);
});
