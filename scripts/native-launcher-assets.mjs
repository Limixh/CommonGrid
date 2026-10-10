import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./go.mjs";

const bridgeNames = ["runtime-bridge.mjs", "tunnel-wire.mjs", "mcp.mjs", "task-broker.mjs"];
const hash = data => createHash("sha256").update(data).digest("hex");
const cacheFile = path.join(root, ".local/native-launcher-build/digests.json");
let digestCache;
async function cachedDigests() {
  if (digestCache) return digestCache;
  try { digestCache = JSON.parse(await readFile(cacheFile, "utf8")); } catch { digestCache = {}; }
  if (!digestCache || typeof digestCache !== "object" || Array.isArray(digestCache)) digestCache = {};
  return digestCache;
}
async function fileHash(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("native_asset_not_regular_file");
  // Incremental developer builds cache only public file digests. Native launch
  // and the worker still hash their actual resources on every operation.
  const cache = await cachedDigests();
  const fingerprint = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  if (cache[filename]?.fingerprint === fingerprint && /^[a-f0-9]{64}$/.test(cache[filename].digest)) return cache[filename].digest;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  const value = digest.digest("hex");
  const after = await lstat(filename);
  if (fingerprint !== JSON.stringify([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs])) throw new Error("native_asset_changed_during_build");
  cache[filename] = {fingerprint, digest: value}; return value;
}
async function writeChanged(filename, bytes) {
  try { if ((await readFile(filename)).equals(Buffer.from(bytes))) return; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(filename, bytes);
}
/** Build-time public assets only. No host CLI account files are consulted. */
export async function prepareNativeLauncher() {
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("native_launcher_build_requires_node_22");
  const pins = JSON.parse(await readFile(path.join(root, "packages/agent-adapters/runtime-assets/native-cli-assets.lock.json"), "utf8"));
  // F0 public downloads and product resources must refer to identical reviewed
  // releases. A pin update requires updating both records deliberately.
  const spikePins = JSON.parse(await readFile(path.join(root, "spike/cli-session/binaries.lock.json"), "utf8"));
  const image = JSON.parse(await readFile(path.join(root, "spike/sandbox/image.lock.json"), "utf8"));
  if (pins.base_image !== image.image || pins.binaries.codex.sha256 !== spikePins.codex.binary_sha256 || pins.binaries.claude.sha256 !== spikePins.claude.sha256 ||
    pins.binaries.codex.version !== spikePins.codex.version || pins.binaries.claude.version !== spikePins.claude.version) throw new Error("native_public_asset_pin_mismatch");
  const launcher = path.join(root, "apps/desktop/src-tauri/resources/launcher");
  const assets = path.join(launcher, "assets");
  await mkdir(assets, {recursive: true});
  const bridges = {};
  for (const name of bridgeNames) {
    const bytes = await readFile(path.join(root, "packages/agent-adapters/runtime-assets", name));
    bridges[name] = hash(bytes); await writeChanged(path.join(assets, name), bytes);
  }
  const binaries = Object.fromEntries(Object.entries(pins.binaries).map(([id, pin]) => [id, {file: pin.file, sha256: pin.sha256}]));
  await writeChanged(path.join(assets, "config.json"), JSON.stringify({schema_version: "1.0", base_image: pins.base_image, binaries, bridges}) + "\n");
  const bundled = await build({entryPoints: [path.join(root, "apps/desktop/native-worker/entry.ts")], platform: "node", target: "node22", format: "esm", bundle: true,
    write: false, logLevel: "silent", define: {__CG_BRIDGE_HASHES__: JSON.stringify(bridges)}, banner: {js: 'import { createRequire as cgCreateRequire } from "node:module"; const require = cgCreateRequire(import.meta.url);'}});
  const workerBytes = bundled.outputFiles[0].contents;
  await writeChanged(path.join(launcher, "worker.mjs"), workerBytes);
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodeHash = await fileHash(process.execPath);
  let nodeCurrent;
  try { nodeCurrent = await fileHash(path.join(launcher, nodeName)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (nodeCurrent !== nodeHash) await copyFile(process.execPath, path.join(launcher, nodeName));
  if (process.platform !== "win32") await chmod(path.join(launcher, nodeName), 0o755);
  await writeChanged(path.join(launcher, "manifest.json"), JSON.stringify({schema_version: "1.0", node_sha256: nodeHash, worker_sha256: hash(workerBytes)}) + "\n");
  let proof;
  try { proof = JSON.parse(await readFile(path.join(root, ".tools/cli-fixtures/verification.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const [provider, pin] of Object.entries(pins.binaries)) {
    const source = path.join(root, ".tools/cli-fixtures", provider), destination = path.join(assets, provider);
    let sourceHash;
    try { sourceHash = await fileHash(source); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (sourceHash === undefined) {
      // Never leave an earlier build's binary behind when this build lacks the
      // reviewed public fixture. Compilation works; runtime reports missing.
      await unlink(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
      continue;
    }
    if (sourceHash !== pin.sha256 || (provider === "claude" && (proof?.claude_manifest_signature_verified !== true || proof.claude_signing_fingerprint !== spikePins.claude.signing_fingerprint || proof.claude_sha256 !== pin.sha256)) ||
      (provider === "codex" && proof?.codex_binary_sha256 !== pin.sha256)) throw new Error("native_public_cli_verification_failed");
    let current;
    try { current = await fileHash(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current !== sourceHash) await copyFile(source, destination);
  }
  await mkdir(path.dirname(cacheFile), {recursive: true});
  await writeFile(cacheFile, JSON.stringify(await cachedDigests()) + "\n");
  return launcher;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareNativeLauncher(); console.log("Native worker resources prepared; host account state was not read.");
}
