import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, runGo } from "./go.mjs";

const dir = path.join(root, ".tools/trivy");
const installed = JSON.parse(await readFile(path.join(dir, "installed.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "spike/artifact-delivery/trivy.lock.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`, asset = lock.assets[platform];
if (!asset || installed.version !== lock.version || installed.platform !== platform || installed.archive_sha256 !== asset.sha256 || installed.binary !== asset.binary) throw new Error("Run npm run install:trivy for this platform");
const binary = path.join(dir, asset.binary), digest = createHash("sha256").update(await readFile(binary)).digest("hex");
if (digest !== installed.binary_sha256 || (asset.binary_sha256 && digest !== asset.binary_sha256)) throw new Error("Installed Trivy changed");
const runDir = path.join(root, ".local/artifact-tests", `run-${Date.now()}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const env = { ...process.env, CG_TEST_TRIVY_BINARY: binary, CG_TEST_TRIVY_SHA256: digest, CG_REQUIRE_TRIVY_TESTS: "1" };
const child = runGo(["test", "./internal/artifact", "./internal/verification", "-count=1", "-json"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let stdout = "", stderr = "";
child.stdout.on("data", (part) => { stdout += part; }); child.stderr.on("data", (part) => { stderr += part; });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
await writeFile(path.join(runDir, "go-test.jsonl"), stdout);
await writeFile(path.join(runDir, "go-test.stderr.log"), stderr);
const events = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const tests = (action) => events.filter((event) => event.Action === action && event.Test).map((event) => event.Test);
const passed = tests("pass"), skipped = tests("skip"), failed = tests("fail");
// File symlinks require a privilege this Windows account may lack. Keep that
// exact platform gap visible; scanner acceptance and all other skips are fatal.
const permittedPlatformSkips = process.platform === "win32" ? ["TestVaultRejectsSymlinkRootAndObjects"] : [];
const unsupported = skipped.filter((name) => permittedPlatformSkips.includes(name));
const report = { checked_at: new Date().toISOString(), platform, scanner: { name: "Trivy", version: lock.version, binary_sha256: digest, archive_sha256: asset.sha256, policy: "v0-75-0-neutral-v1", real_executable_tested: passed.includes("TestTrivyRealAcceptance"), network_policy: "offline_flags_only_development_adapter" }, passed, skipped, unsupported_platform_checks: unsupported, failed, success: code === 0 && passed.includes("TestTrivyRealAcceptance") && skipped.every((name) => permittedPlatformSkips.includes(name)), verifier_harness: "trusted_fixture_only", real_model_inference: false, real_account_tested: false, execution_enabled: false, isolation_gate: "not_evaluated" };
await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
if (!report.success) { process.stderr.write(stderr); for (const event of events) if (event.Action === "output" && failed.includes(event.Test)) process.stderr.write(event.Output ?? ""); throw new Error(`Artifact acceptance failed: ${runDir}`); }
console.log(`PASS: ${passed.length} artifact/verifier controls; real pinned scanner; ${unsupported.length} unsupported platform check(s) recorded`);
console.log(`Report: ${path.join(runDir, "report.json")}`);
