// Separate Linux fixture binaries; never install globally or read account state.
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, copyFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("../spike/cli-session/binaries.lock.json", import.meta.url), "utf8"));
const output = path.join(root, ".tools/cli-fixtures");
await mkdir(output, { recursive: true });
const hash = (data) => createHash("sha256").update(data).digest("hex");
async function run(command, args, env = process.env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    child.stdout.on("data", (data) => { if (stdout.length < 1_048_576) stdout += data; });
    child.stderr.on("data", (data) => { if (stderr.length < 4096) stderr += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`fixture_setup_failed: ${stderr.slice(0,500)}`)));
  });
}
async function download(url, destination) {
  if (process.platform === "win32") {
    // Use the Windows trust store; do not disable TLS validation for enterprise
    // CAs that Node's bundled trust store does not recognize.
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:CG_FIXTURE_URL -OutFile $env:CG_FIXTURE_OUTPUT"],
    { ...process.env, CG_FIXTURE_URL: url, CG_FIXTURE_OUTPUT: destination });
  } else {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`fixture_download_http_${response.status}`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  }
}
for (const [provider, item] of Object.entries(lock).filter(([id]) => ["codex", "claude"].includes(id))) {
  const archive = path.join(output, provider === "codex" ? "codex.tar.gz" : "claude");
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!bytes || hash(bytes) !== item.sha256) {
    console.log(`Downloading official ${provider} ${item.version} Linux fixture...`);
    await download(item.url, archive);
    bytes = await readFile(archive);
  }
  if (hash(bytes) !== item.sha256) throw new Error(`${provider}_checksum_mismatch`);
  if (provider === "codex") {
    await run("tar", ["-xzf", archive, "-C", output, item.archive_binary]);
    await copyFile(path.join(output, item.archive_binary), path.join(output, "codex"));
    if (hash(await readFile(path.join(output, "codex"))) !== item.binary_sha256) throw new Error("codex_binary_checksum_mismatch");
  }
  console.log(`Verified ${provider} ${item.version} SHA-256.`);
}
console.log(`Fixture binaries: ${output}`);

const manifest = path.join(output, "manifest.json");
await download(lock.claude.manifest_url, manifest);
const manifestData = JSON.parse(await readFile(manifest, "utf8"));
if (manifestData.platforms[lock.platform].checksum !== lock.claude.sha256)
  throw new Error("claude_manifest_pin_mismatch");
const signature = path.join(output, "manifest.json.sig"), key = path.join(output, "claude-code.asc");
await download(`${lock.claude.manifest_url}.sig`, signature);
await download(lock.claude.signing_key_url, key);
const keyring = path.join(output, "keyring");
await mkdir(keyring, { recursive: true });
const gpg = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/gpg.exe" : "gpg";
if (process.platform === "win32") await access(gpg);
// gpgv with an explicit dearmored keyring does not start gpg-agent or consult
// user keys. Pin the actual primary signer reported by VALIDSIG as well.
const publicKeyring = path.join(keyring, "release.gpg");
await run(gpg, ["--no-options", "--homedir", keyring, "--batch", "--yes", "--dearmor", "--output", publicKeyring, key]);
const gpgv = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/gpgv.exe" : "gpgv";
const status = await run(gpgv, ["--homedir", keyring, "--keyring", "release.gpg", "--status-fd", "1", signature, manifest]);
if (!status.split(/\r?\n/).some((line) => line.startsWith("[GNUPG:] VALIDSIG ") && [line.split(" ")[2], line.split(" ").at(-1)].includes(lock.claude.signing_fingerprint)))
  throw new Error("claude_manifest_signer_mismatch");
await writeFile(path.join(output, "verification.json"), JSON.stringify({ codex_sha256: lock.codex.sha256, codex_binary_sha256: hash(await readFile(path.join(output, "codex"))), claude_sha256: lock.claude.sha256, claude_manifest_signature_verified: true, claude_signing_fingerprint: lock.claude.signing_fingerprint }, null, 2) + "\n");
console.log("Claude release manifest signature verified in the project-only keyring.");
