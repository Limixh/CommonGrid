import { existsSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { runGo, root } from "./go.mjs";

const [mode = "test", ...args] = process.argv.slice(2);
const cwd = path.join(root, "spike/temporal");
const tmp = path.join(root, ".tools/tmp");
mkdirSync(tmp, { recursive: true });
const env = { ...process.env, GOTMPDIR: tmp, GOCACHE: path.join(root, ".tools/go-cache"), GOMODCACHE: path.join(root, ".tools/go-mod") };
let goArgs;
let temporal;
if (mode === "test") goArgs = ["test", "./...", ...args];
else if (mode === "go") goArgs = args;
else if (mode === "recovery") {
  temporal = path.join(root, ".tools/temporal", process.platform === "win32" ? "temporal.exe" : "temporal");
  if (!existsSync(temporal)) throw new Error("Run npm run install:temporal first");
  goArgs = ["build", "-o", path.join(tmp, `temporal-recovery-${process.pid}${process.platform === "win32" ? ".exe" : ""}`), "./cmd/recovery"];
} else throw new Error(`Unknown spike mode: ${mode}`);
let active;
function stopOwnedTree() {
  if (!active?.pid || active.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(active.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-active.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
let stopping = false;
function interrupt() { stopping = true; stopOwnedTree(); }
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.on("exit", stopOwnedTree);
const options = { cwd, env, windowsHide: true, detached: process.platform !== "win32" };
function wait(child) {
  active = child;
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
}
let code = await wait(runGo(goArgs, options));
if (mode === "recovery" && code === 0 && !stopping) {
  code = await wait(spawn(goArgs[2], ["--server-binary", temporal, "--state-dir", path.join(root, ".local/temporal-recovery"), ...args], { ...options, stdio: "inherit" }));
}
active = undefined;
process.exitCode = stopping ? 130 : code;
