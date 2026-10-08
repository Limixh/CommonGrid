// Dedicated real PostgreSQL integration tests. Never falls back to DATABASE_URL.
// Windows uses a verified, test-only portable distribution inside this checkout.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { root, runGo } from "./go.mjs";

const runDir = path.join(root, ".local/postgres-tests", `run-${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const tmp = path.join(root, ".tools/tmp");
await mkdir(tmp, { recursive: true });
const env = { ...process.env, GOCACHE: path.join(root, ".tools/go-cache"), GOMODCACHE: path.join(root, ".tools/go-mod"), GOTMPDIR: tmp, CG_REQUIRE_DATABASE_TESTS: "1" };
const migrationsDir = new URL("../services/coordinator/internal/store/migrations/", import.meta.url);
let pgctl, dataDir, started = false;
function controlled(command, args, capture = false) {
  const logFd = capture ? undefined : openSync(path.join(runDir, "setup.log"), "a");
  let result;
  try {
    // A background postmaster can inherit pipes and prevent spawnSync from
    // seeing EOF after pg_ctl exits. Regular log files do not have that issue.
    result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 60_000, ...(capture ? {} : { stdio: ["ignore", logFd, logFd] }) });
  } finally { if (logFd !== undefined) closeSync(logFd); }
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed; see ${path.join(runDir, "setup.log")}`);
  return capture ? result.stdout : undefined;
}
function stop() {
  if (started) {
    const result = spawnSync(pgctl, ["-D", dataDir, "-m", "immediate", "-w", "-t", "15", "stop"], { windowsHide: true, stdio: "ignore", timeout: 20_000 });
    started = false;
    if (result.status !== 0) console.error(`Owned PostgreSQL test server cleanup failed; data directory: ${dataDir}`);
  }
}
process.on("exit", stop);
let goChild;
let interrupted = false;
function interrupt() {
  interrupted = true;
  if (goChild?.pid && goChild.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(goChild.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else goChild.kill("SIGTERM");
  }
  stop();
}
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

try {
  let serverVersion = "external dedicated test database";
  if (!env.CG_TEST_DATABASE_URL) {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Set CG_TEST_DATABASE_URL to a dedicated PostgreSQL test database on this platform");
    const version = "18.6.0";
    const binaryDir = path.join(root, ".tools/postgres");
    await mkdir(binaryDir, { recursive: true });
    const archive = path.join(binaryDir, "postgres-18.6.zip");
    let bytes;
    if (existsSync(archive)) bytes = await readFile(archive);
    else {
      console.log("Downloading pinned PostgreSQL 18.6 test binaries into .tools/postgres");
      const url = `https://repo.maven.apache.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-windows-amd64/${version}/embedded-postgres-binaries-windows-amd64-${version}.jar`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`PostgreSQL test download: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== "b7ef2d03588e0439f0d0a2250f43905f7464f1e96ace47703ceaf79094198150") throw new Error("PostgreSQL test binary checksum mismatch");
    await writeFile(archive, bytes);
    controlled("tar", ["-xf", archive, "-C", binaryDir, "postgres-windows-x86_64.txz"]);
    controlled("tar", ["-xf", path.join(binaryDir, "postgres-windows-x86_64.txz"), "-C", binaryDir]);
    serverVersion = controlled(path.join(binaryDir, "bin/postgres.exe"), ["--version"], true).trim();
    if (serverVersion !== "postgres (PostgreSQL) 18.6") throw new Error("Unexpected portable PostgreSQL version");
    dataDir = path.join(runDir, "data");
    pgctl = path.join(binaryDir, "bin/pg_ctl.exe");
    const password = randomBytes(24).toString("hex");
    const passwordFile = path.join(runDir, "password.tmp");
    await writeFile(passwordFile, password+"\n", { mode: 0o600 });
    try { controlled(path.join(binaryDir, "bin/initdb.exe"), ["-D", dataDir, "-U", "cgtest", "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", "--pwfile", passwordFile]); }
    finally { await unlink(passwordFile); }
    const listener = createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    // Only generated numeric port/loopback flags reach pg_ctl's option string.
    started = true;
    controlled(pgctl, ["-D", dataDir, "-l", path.join(runDir, "server.log"), "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${port} -F`, "start"]);
    env.CG_TEST_DATABASE_URL = `postgresql://cgtest:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
  }
  console.log(`Testing domain transactions on ${serverVersion}`);
  let stdout = "", stderr = "";
  goChild = runGo(["test", "./internal/store", "./internal/outbox", "./internal/httpapi", "-count=1", "-json"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  goChild.stdout.on("data", (chunk) => { stdout += chunk; });
  goChild.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { goChild.once("error", reject); goChild.once("exit", (code) => resolve(code ?? 1)); });
  await writeFile(path.join(runDir, "go-test.jsonl"), stdout);
  await writeFile(path.join(runDir, "go-test.stderr.log"), stderr);
  const events = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const passed = events.filter((event) => event.Action === "pass" && event.Test).map((event) => event.Test);
  const skipped = events.filter((event) => event.Action === "skip" && event.Test).map((event) => event.Test);
  const failed = events.filter((event) => event.Action === "fail" && event.Test).map((event) => event.Test);
  const migrationHashes = {};
  for (const name of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort()) {
    migrationHashes[name] = createHash("sha256").update(await readFile(new URL(name, migrationsDir))).digest("hex");
  }
  const report = { checked_at: new Date().toISOString(), platform: process.platform, server_version: serverVersion, migrations_sha256: migrationHashes, passed, skipped, failed, success: code === 0 && skipped.length === 0 && !interrupted, independent_artifact_scanner: env.CG_REQUIRE_TRIVY_TESTS === "1" ? "required_pinned_trivy" : "explicit_fixture", verifier_harness: "trusted_fixture_only", execution_enabled: false, isolation_gate: "not_evaluated", real_account_tested: false, real_model_inference: false };
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2)+"\n");
  if (!report.success) {
    for (const event of events) if (event.Action === "output" && (failed.includes(event.Test) || !event.Test)) process.stderr.write(event.Output ?? "");
    if (stderr) process.stderr.write(stderr);
    throw new Error(`PostgreSQL integration failed; report: ${path.join(runDir, "report.json")}`);
  }
  console.log(`PASS: ${passed.length} tests, no skipped database tests`);
  console.log(`Report: ${path.join(runDir, "report.json")}`);
} finally { stop(); }
