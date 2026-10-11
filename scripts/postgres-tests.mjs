// Dedicated real PostgreSQL integration tests. Never falls back to DATABASE_URL.
// Windows uses a verified, test-only portable distribution inside this checkout.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { root, runGo } from "./go.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.some((arg) => arg !== "--cloud-ui") || new Set(arguments_).size !== arguments_.length) {
  throw new Error("Usage: node scripts/postgres-tests.mjs [--cloud-ui]");
}
const cloudUI = arguments_.includes("--cloud-ui");
const runDir = path.join(root, ".local/postgres-tests", `run-${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const tmp = path.join(root, ".tools/tmp");
await mkdir(tmp, { recursive: true });
const env = { ...process.env, GOCACHE: path.join(root, ".tools/go-cache"), GOMODCACHE: path.join(root, ".tools/go-mod"), GOTMPDIR: tmp, CG_REQUIRE_DATABASE_TESTS: "1" };
const readyFile = path.join(runDir, "cloud-ui-ready.json");
// Do not allow inherited UI-mode state to affect the ordinary database suite.
delete env.CG_CLOUD_UI_READY_FILE;
if (cloudUI) env.CG_CLOUD_UI_READY_FILE = readyFile;
const migrationsDir = new URL("../services/coordinator/internal/store/migrations/", import.meta.url);
let pgctl, dataDir, started = false;
const postgresCleanup = { owned: false, status: "not_applicable", attempts: 0 };
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
  if (started && postgresCleanup.attempts < 2) {
    postgresCleanup.attempts++;
    const result = spawnSync(pgctl, ["-D", dataDir, "-m", "immediate", "-w", "-t", "15", "stop"], { windowsHide: true, stdio: "ignore", timeout: 20_000 });
    if (!result.error && result.status === 0) {
      started = false;
      postgresCleanup.status = "verified";
    } else {
      postgresCleanup.status = "failed";
      console.error(`Owned PostgreSQL test server cleanup failed; data directory: ${dataDir}`);
    }
  }
  return postgresCleanup;
}
process.on("exit", stop);
let goChild, uiChild;
let interrupted = false;
function terminateTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
  } else {
    // Cloud-mode children own a process group; kill only that group.
    try { cloudUI ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
function interrupt() {
  interrupted = true;
  terminateTree(uiChild);
  terminateTree(goChild);
  stop();
}
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function bounded(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

async function waitForCloudReady(completion) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Cloud UI acceptance interrupted");
    // Check completion before the file so stale readiness cannot mask exit.
    if (goChild.exitCode !== null || goChild.signalCode !== null) throw new Error("Cloud UI Go test exited before readiness");
    let body;
    try { body = await readFile(readyFile, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Cloud UI readiness file could not be read"); }
    if (body !== undefined) {
      let metadata;
      try { metadata = JSON.parse(body); }
      catch { throw new Error("Cloud UI readiness metadata is malformed"); }
      // Only the loopback origin is extracted here. IDs remain in the owned
      // ready file for the smoke script; no auth/session data is printed.
      let url;
      try { url = new URL(metadata?.url); }
      catch { throw new Error("Cloud UI readiness URL is malformed"); }
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          !url.port || Number(url.port) < 1 || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("Cloud UI readiness URL must be a credential-free loopback HTTP origin");
      }
      return url.origin;
    }
    await Promise.race([delay(250), completion.then(() => { throw new Error("Cloud UI Go test exited before readiness"); })]);
  }
  throw new Error("Cloud UI readiness timed out after 120 seconds");
}

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
    postgresCleanup.owned = true;
    postgresCleanup.status = "pending";
    controlled(pgctl, ["-D", dataDir, "-l", path.join(runDir, "server.log"), "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${port} -F`, "start"]);
    env.CG_TEST_DATABASE_URL = `postgresql://cgtest:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
  }
  console.log(`Testing domain transactions on ${serverVersion}`);
  let stdout = "", stderr = "";
  const goArguments = cloudUI
    ? ["test", "./internal/httpapi", "-run", "^TestPostgresCloudContributionAndCatalog$", "-count=1", "-json", "-timeout", "30m"]
    : ["test", "./internal/store", "./internal/outbox", "./internal/httpapi", "-count=1", "-json"];
  goChild = runGo(goArguments, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(cloudUI && process.platform !== "win32" ? { detached: true } : {}) });
  let pendingLines = "";
  goChild.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!cloudUI) return;
    pendingLines += chunk;
    const lines = pendingLines.split(/\r?\n/);
    pendingLines = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (["run", "pass", "fail", "skip"].includes(event.Action)) console.log(`Go ${event.Action}: ${event.Test ?? event.Package}`);
      } catch { /* Raw output remains in the owned log, never streamed. */ }
    }
  });
  goChild.stderr.on("data", (chunk) => { stderr += chunk; });
  const goCompletion = new Promise((resolve) => {
    goChild.once("error", () => resolve(1));
    goChild.once("close", (code) => resolve(code ?? 1));
  });
  let cloudFailure, cloudUIPassed = false;
  if (cloudUI) {
    try {
      const apiURL = await waitForCloudReady(goCompletion);
      console.log("Cloud UI fixture ready; starting native acceptance");
      uiChild = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts/native-cloud-ui-smoke.mts"), "--api-url", apiURL, "--ready-file", readyFile],
        { cwd: root, env: process.env, windowsHide: true, stdio: "inherit", ...(process.platform !== "win32" ? { detached: true } : {}) });
      const uiCompletion = new Promise((resolve) => {
        uiChild.once("error", () => resolve(1));
        uiChild.once("close", (code) => resolve(code ?? 1));
      });
      const uiCode = await bounded(Promise.race([uiCompletion,
        goCompletion.then(() => { throw new Error("Cloud UI Go test exited during native acceptance"); })]),
        25 * 60_000, "Cloud UI native acceptance timed out");
      if (uiCode !== 0 || interrupted) throw new Error("Cloud UI native acceptance failed");
      cloudUIPassed = true;
    } catch (error) {
      cloudFailure = error;
      terminateTree(uiChild);
      terminateTree(goChild);
    } finally {
      await writeFile(readyFile + ".stop", "stop\n");
    }
  }
  let code;
  try { code = cloudUI ? await bounded(goCompletion, 30_000, "Cloud UI Go test did not stop after acceptance") : await goCompletion; }
  catch (error) { cloudFailure = error; terminateTree(goChild); code = await bounded(goCompletion, 10_000, "Cloud UI Go test cleanup timed out"); }
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
  // The Go process has fully exited. Verify owned PostgreSQL shutdown before
  // finalizing success; finally/exit may retry a failed stop once at most.
  stop();
  // Match databaseAPI's opt-in exactly: either pinned-scanner variable also
  // requests Trivy, including incomplete configuration that the Go test rejects.
  const independentScanner = env.CG_REQUIRE_TRIVY_TESTS === "1" || Boolean(env.CG_TEST_TRIVY_BINARY || env.CG_TEST_TRIVY_SHA256);
  const report = { checked_at: new Date().toISOString(), platform: process.platform, server_version: serverVersion, migrations_sha256: migrationHashes, passed, skipped, failed, success: code === 0 && skipped.length === 0 && !interrupted && postgresCleanup.status !== "failed" && (!cloudUI || (cloudUIPassed && !cloudFailure)), postgres_cleanup: { ...postgresCleanup }, independent_artifact_scanner: independentScanner ? "required_pinned_trivy" : "explicit_fixture", verifier_harness: "trusted_fixture_only", execution_enabled: false, isolation_gate: "not_evaluated", real_account_tested: false, real_model_inference: false, ...(cloudUI ? { cloud_ui_acceptance: cloudUIPassed && !cloudFailure ? "passed" : "failed" } : {}) };
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2)+"\n");
  if (!report.success) {
    if (cloudUI) console.error(cloudFailure?.message ?? "Cloud UI database acceptance failed; inspect the owned run logs");
    else {
      for (const event of events) if (event.Action === "output" && (failed.includes(event.Test) || !event.Test)) process.stderr.write(event.Output ?? "");
      if (stderr) process.stderr.write(stderr);
    }
    throw new Error(`PostgreSQL integration failed; report: ${path.join(runDir, "report.json")}`);
  }
  console.log(`PASS: ${passed.length} tests, no skipped database tests`);
  console.log(`Report: ${path.join(runDir, "report.json")}`);
} finally {
  if (cloudUI) {
    try { await writeFile(readyFile + ".stop", "stop\n"); }
    finally { terminateTree(uiChild); terminateTree(goChild); stop(); }
  } else { stop(); }
}
