import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "1.9.1";
const platforms = {
  "win32-x64": ["windows_amd64", "42637464c337a3da203fbd4e8c688e4b2d511fd42bd19c337c0422e923a7b619"],
  "win32-arm64": ["windows_arm64", "cfdfe43e69a2261191148294b1f7e3a7088ef8d3dc1ab1909b115b1784b6c6fe"],
  "linux-x64": ["linux_amd64", "09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5"],
  "linux-arm64": ["linux_arm64", "6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145"],
  "darwin-x64": ["darwin_amd64", "48cdd6c84c56e27ae8e4d9a47052b89289a9c552dee029b49dd312c6fb72873f"],
  "darwin-arm64": ["darwin_arm64", "41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56"],
};
const platform = platforms[`${process.platform}-${process.arch}`];
if (!platform) throw new Error("Unsupported Temporal CLI platform");
const dir = path.join(root, ".tools/temporal");
const asset = `temporal_cli_${version}_${platform[0]}.tar.gz`;
const archive = path.join(dir, asset);
await mkdir(dir, { recursive: true });
let bytes;
try { bytes = await readFile(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!bytes || createHash("sha256").update(bytes).digest("hex") !== platform[1]) {
  console.log(`Downloading pinned Temporal CLI ${version} into .tools/temporal`);
  const response = await fetch(`https://github.com/temporalio/cli/releases/download/v${version}/${asset}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Temporal download: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== platform[1]) throw new Error("Temporal CLI checksum mismatch");
  await writeFile(archive, bytes);
}
const binary = process.platform === "win32" ? "temporal.exe" : "temporal";
const extraction = spawnSync("tar", ["-xzf", archive, "-C", dir, binary], { stdio: "inherit", windowsHide: true });
if (extraction.error) throw extraction.error;
if (extraction.status !== 0) throw new Error("Temporal extraction failed");
const probe = spawnSync(path.join(dir, binary), ["--version"], { stdio: "inherit", windowsHide: true });
if (probe.error) throw probe.error;
if (probe.status !== 0) throw new Error("Temporal CLI version probe failed");
