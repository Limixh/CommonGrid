import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("../spike/artifact-delivery/trivy.lock.json", import.meta.url), "utf8"));
const platform = `${process.platform}-${process.arch}`, asset = lock.assets[platform];
if (!asset) throw new Error("Unsupported pinned Trivy platform");
const dir = path.join(root, ".tools/trivy");
await mkdir(dir, { recursive: true, mode: 0o700 });
if ((await lstat(dir)).isSymbolicLink()) throw new Error("Trivy tool directory must be local");
const archive = path.join(dir, asset.name), hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!bytes || hash(bytes) !== asset.sha256) {
  console.log(`Downloading pinned Trivy ${lock.version} into .tools/trivy`);
  const response = await fetch(`https://github.com/aquasecurity/trivy/releases/download/v${lock.version}/${asset.name}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Trivy download HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 80 * 1024 * 1024) throw new Error("Trivy archive oversized");
  bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 80 * 1024 * 1024 || hash(bytes) !== asset.sha256) throw new Error("Trivy archive checksum mismatch");
  await writeFile(archive, bytes, { mode: 0o600 });
}
// Only the fixed executable is extracted from the checksum-verified official
// archive. No archive-provided scripts, templates or configuration are run.
const binary = path.join(dir, asset.binary);
let alreadyPinned = false;
if (asset.binary_sha256) {
  try { const existing = await lstat(binary); alreadyPinned = existing.isFile() && !existing.isSymbolicLink() && hash(await readFile(binary)) === asset.binary_sha256; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
// Preserve a correctly pinned binary while another local check is using it.
if (!alreadyPinned) {
  const extraction = spawnSync("tar", ["-xf", archive, "-C", dir, asset.binary], { windowsHide: true, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 });
  if (extraction.error || extraction.status !== 0) throw new Error("Pinned Trivy extraction failed; stop active scanner checks before retrying");
}
const info = await lstat(binary);
if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) throw new Error("Invalid Trivy executable");
await chmod(binary, 0o700);
const digest = hash(await readFile(binary));
if (asset.binary_sha256 && digest !== asset.binary_sha256) throw new Error("Trivy binary checksum mismatch");
const probe = spawnSync(binary, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {} });
if (probe.error || probe.status !== 0 || !probe.stdout.split(/\r?\n/).includes(`Version: ${lock.version}`)) throw new Error("Trivy version mismatch");
await writeFile(path.join(dir, "installed.json"), JSON.stringify({ version: lock.version, platform, archive_sha256: asset.sha256, binary: asset.binary, binary_sha256: digest }, null, 2) + "\n");
console.log(`Pinned Trivy ${lock.version} ready; credentials and system PATH unchanged`);
