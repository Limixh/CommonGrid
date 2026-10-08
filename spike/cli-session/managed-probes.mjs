// These functions are serialized into synthetic task namespaces, never run on
// the host. They only emit boolean evidence, not proc contents or canary bytes.
export async function separationProbe(canary, privatePid) {
  const f = require("node:fs"), n = require("node:net"), cp = require("node:child_process");
  const denied = target => { try { f.readFileSync(target); return false; } catch { return true; } };
  const privatePath = "/home/node/cg-synthetic-private/canary";
  const processes = f.readdirSync("/proc").filter(name => /^\d+$/.test(name));
  let processAbsent = true, fdAbsent = true, envAbsent = !JSON.stringify(process.env).includes(canary) && !Object.hasOwn(process.env, "CG_TOOL_TOKEN");
  for (const pid of processes) {
    try { if (f.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] === "cg-synthetic-private-daemon") processAbsent = false; } catch {}
    try { const env = f.readFileSync(`/proc/${pid}/environ`, "utf8"); if (env.includes(canary) || env.includes("CG_TOOL_TOKEN=")) envAbsent = false; } catch {}
    try { for (const fd of f.readdirSync(`/proc/${pid}/fd`)) { try { if (f.readlinkSync(`/proc/${pid}/fd/${fd}`).includes("cg-synthetic-private")) fdAbsent = false; } catch {} } } catch {}
  }
  let rootReadonly = false; try { f.writeFileSync("/etc/cg-synthetic-escape", "forbidden"); } catch { rootReadonly = true; }
  f.symlinkSync(privatePath, "/task/cg-private-link");
  const unreachable = options => new Promise(resolve => { const socket = n.connect(options); socket.on("connect", () => { socket.destroy(); resolve(false); }); socket.on("error", () => resolve(true)); socket.setTimeout(800, () => { socket.destroy(); resolve(true); }); });
  // Fixed x86-64 ELF issues only ptrace(PTRACE_ATTACH, synthetic numeric PID).
  // EPERM/ESRCH are accepted. Any successful attachment fails this probe.
  const code = Buffer.from("b865000000bf10000000be0000000031d24531d20f054883f8ff74124883f8fd740cbf01000000b83c0000000f0531ffb83c0000000f05", "hex");
  code.writeUInt32LE(privatePid, 11);
  const elf = Buffer.alloc(120 + code.length); Buffer.from("7f454c46020101000000000000000000", "hex").copy(elf);
  elf.writeUInt16LE(2,16); elf.writeUInt16LE(62,18); elf.writeUInt32LE(1,20); elf.writeBigUInt64LE(0x400078n,24); elf.writeBigUInt64LE(64n,32); elf.writeUInt16LE(64,52); elf.writeUInt16LE(56,54); elf.writeUInt16LE(1,56);
  elf.writeUInt32LE(1,64); elf.writeUInt32LE(5,68); elf.writeBigUInt64LE(0x400000n,80); elf.writeBigUInt64LE(0x400000n,88); elf.writeBigUInt64LE(BigInt(elf.length),96); elf.writeBigUInt64LE(BigInt(elf.length),104); elf.writeBigUInt64LE(4096n,112); code.copy(elf,120);
  f.writeFileSync("/task/cg-ptrace-probe",elf,{mode:0o700});
  const ptrace = cp.spawnSync("/task/cg-ptrace-probe", [], {timeout:1000});
  const status = f.readFileSync("/proc/self/status", "utf8");
  console.log(JSON.stringify({private_paths_denied:[privatePath,"/proc/1/root"+privatePath,"/task/cg-private-link","/opt/cg/mcp.mjs","/var/run/docker.sock"].every(denied),process_absent:processAbsent,private_fd_absent:fdAbsent,private_env_absent:envAbsent,root_readonly:rootReadonly,ptrace_denied:process.arch==="x64"&&ptrace.status===0,no_capabilities:/CapEff:\s+0+\n/.test(status),no_new_privileges:/NoNewPrivs:\s+1\n/.test(status),seccomp_filter:/Seccomp:\s+2\n/.test(status),private_sockets_unreachable:(await Promise.all([{host:"127.0.0.1",port:9876},{host:"127.0.0.1",port:9877},{host:"127.0.0.1",port:19876},{path:"/home/node/cg-synthetic-private/daemon.sock"}].map(unreachable))).every(Boolean),external_network_unreachable:await unreachable({host:"8.8.8.8",port:443})}));
}

export async function resourceProbe() {
  const f = require("node:fs"), cp = require("node:child_process"); let tmpfsBounded = false;
  const file = f.openSync("/tmp/cg-bounded-fill", "w"), chunk = Buffer.alloc(1_048_576);
  try { for (let i=0;i<80;i++) f.writeSync(file, chunk); } catch(error) { tmpfsBounded = error.code === "ENOSPC"; } finally { f.closeSync(file); f.unlinkSync("/tmp/cg-bounded-fill"); }
  const children = []; let pidsBounded = false;
  for (let i=0;i<160;i++) {
    const child = cp.spawn("/bin/sleep",["20"],{stdio:"ignore"}); children.push(child);
    await new Promise(resolve => { child.once("spawn",resolve); child.once("error",error => { if(error.code === "EAGAIN") pidsBounded = true; resolve(); }); });
    if (pidsBounded) break;
  }
  const exits = children.filter(child => child.pid).map(child => new Promise(resolve => { child.once("close",resolve); child.kill("SIGKILL"); })); await Promise.all(exits);
  console.log(JSON.stringify({tmpfs_bounded:tmpfsBounded,pids_bounded:pidsBounded,children_started:children.filter(child=>child.pid).length}));
}
