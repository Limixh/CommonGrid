import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { ManagedCliRuntime, ManagedPreparationError, type ManagedRuntimeAssets } from "../../../packages/agent-adapters/src/managed-runtime.ts";
import { dockerCommand } from "../../../packages/agent-adapters/src/task-runtime.ts";
import pins from "../../../packages/agent-adapters/runtime-assets/native-cli-assets.lock.json";

declare const __CG_BRIDGE_HASHES__: Record<string, string>;
export type Provider = "claude" | "codex";
export type CheckError = "asset_missing" | "asset_invalid" | "docker_unavailable" | "image_missing" | "cli_check_failed" | "worker_failed" | "cleanup_failed" | "deadline_exceeded" | "cancelled";
export interface Boot { type: "boot"; schema_version: "1.0"; request_id: string; provider: Provider; journal_root: string; assets_root: string }
export type Frame = {type: "progress"; phase: "preparing" | "checking" | "cleaning"} |
  {type: "result"; outcome: "passed" | "cancelled" | "failed" | "needs_review"; cli_version: string | null; error_code: CheckError | null; cleanup: "verified" | "unknown"};
class CheckFailure extends Error { constructor(readonly code: CheckError) { super(code); } }
const exact = (value: unknown, keys: string[]): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
export function parseBoot(value: unknown): Boot {
  if (!exact(value, ["type", "schema_version", "request_id", "provider", "journal_root", "assets_root"]) || value.type !== "boot" || value.schema_version !== "1.0" ||
    typeof value.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.request_id) ||
    !["claude", "codex"].includes(value.provider) || typeof value.journal_root !== "string" || typeof value.assets_root !== "string" ||
    ![value.journal_root, value.assets_root].every(p => p.length < 4096 && !p.includes("\0") && path.isAbsolute(p))) throw new CheckFailure("worker_failed");
  return value as unknown as Boot;
}
async function digest(filename: string, maximum: number): Promise<string> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new CheckFailure("asset_invalid");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length; if (bytes > maximum) throw new CheckFailure("asset_invalid"); hash.update(chunk);
  }
  return hash.digest("hex");
}
async function readConfig(filename: string) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new CheckFailure("asset_invalid");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length; if (size > 8192) throw new CheckFailure("asset_invalid"); chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function verifyAssets(boot: Boot, bridgeHashes: Record<string, string> = __CG_BRIDGE_HASHES__): Promise<ManagedRuntimeAssets> {
  try {
    const root = await lstat(boot.assets_root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new CheckFailure("asset_invalid");
    const config: unknown = JSON.parse(await readConfig(path.join(boot.assets_root, "config.json")));
    // The public coding catalog is optional: a build without its pinned source still works and the task runtime reports it missing.
    const catalogPin = pins.codex_catalog, hasCatalog = Object.hasOwn(Object(config), "catalog");
    if (!exact(config, ["schema_version", "base_image", "binaries", "bridges", ...(hasCatalog ? ["catalog"] : [])]) || config.schema_version !== "1.0" || config.base_image !== pins.base_image ||
      (hasCatalog && config.catalog !== null && (!exact(config.catalog, ["file", "sha256"]) || config.catalog.file !== catalogPin.file || config.catalog.sha256 !== catalogPin.sha256)) ||
      JSON.stringify(config.binaries) !== JSON.stringify(Object.fromEntries(Object.entries(pins.binaries).map(([id, pin]) => [id, {file: pin.file, sha256: pin.sha256}]))) ||
      !exact(config.bridges, Object.keys(bridgeHashes)) || Object.entries(bridgeHashes).some(([name, hash]) => config.bridges[name] !== hash)) throw new CheckFailure("asset_invalid");
    for (const [name, hash] of Object.entries(bridgeHashes)) {
      if (await digest(path.join(boot.assets_root, name), 1_048_576) !== hash) throw new CheckFailure("asset_invalid");
    }
    let catalog: Pick<ManagedRuntimeAssets, "codexCatalog"> = {};
    if (hasCatalog && config.catalog !== null) {
      const filePath = path.join(boot.assets_root, catalogPin.file);
      if (await digest(filePath, 262_144) !== catalogPin.sha256) throw new CheckFailure("asset_invalid");
      catalog = {codexCatalog: {filePath, sha256: catalogPin.sha256}};
    }
    const pin = pins.binaries[boot.provider];
    if (await digest(path.join(boot.assets_root, pin.file), 536_870_912) !== pin.sha256) throw new CheckFailure("asset_invalid");
    return {baseImage: pins.base_image, bridgeRoot: boot.assets_root, journalRoot: boot.journal_root, ...catalog,
      binaries: {claude: {binaryPath: path.join(boot.assets_root, "claude"), sha256: pins.binaries.claude.sha256}, codex: {binaryPath: path.join(boot.assets_root, "codex"), sha256: pins.binaries.codex.sha256}}};
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure((error as NodeJS.ErrnoException).code === "ENOENT" ? "asset_missing" : "asset_invalid");
  }
}
interface CheckRuntime { start(options: {signal: AbortSignal}): Promise<unknown>; exec(args: string[], timeout: number, options: {signal: AbortSignal; maxBytes: number}): Promise<{code: number; stdout: string}>; destroy(options: {signal: AbortSignal}): Promise<unknown> }
// The native environment excludes host Docker contexts and credentials. Docker
// Desktop's Linux pipe can differ from Docker's default Windows pipe. Probe only
// these fixed local endpoints, then pin one for this single-operation worker.
export async function selectWindowsDockerEndpoint(signal: AbortSignal,
  probe: () => Promise<{code: number; stdout: string}> = () => dockerCommand(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], {signal, timeoutMs: 10_000, maxBytes: 8192}),
  environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const endpoint of ["npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/docker_engine"]) {
    signal.throwIfAborted(); environment.DOCKER_HOST = endpoint;
    try {
      const result = await probe(); signal.throwIfAborted();
      if (result.code === 0 && result.stdout.trim() === "linux/amd64") return;
    } catch { signal.throwIfAborted(); }
  }
  delete environment.DOCKER_HOST;
  throw new CheckFailure("docker_unavailable");
}
export interface CheckDependencies {
  assets(boot: Boot): Promise<ManagedRuntimeAssets>;
  prerequisite(assets: ManagedRuntimeAssets, signal: AbortSignal): Promise<void>;
  prepare(provider: Provider, options: {assets: ManagedRuntimeAssets; signal: AbortSignal}): Promise<CheckRuntime>;
}
export async function verifyDockerPrerequisite(assets: ManagedRuntimeAssets, signal: AbortSignal,
  command: typeof dockerCommand = dockerCommand, platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = {signal, timeoutMs: 10_000, maxBytes: 8192};
  const versionArgs = ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"];
  try {
    if (platform === "win32") await selectWindowsDockerEndpoint(signal, () => command(versionArgs, options), environment);
    const version = await command(versionArgs, options);
    if (version.code !== 0 || version.stdout.trim() !== "linux/amd64") throw new CheckFailure("docker_unavailable");
    const image = await command(["image", "inspect", "--format", "{{.Id}}", assets.baseImage], options);
    if (image.code !== 0) throw new CheckFailure(/\bno such image:/i.test(image.stderr) ? "image_missing" : "docker_unavailable");
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    throw new CheckFailure("docker_unavailable");
  }
}
const dependencies: CheckDependencies = {
  assets: verifyAssets,
  prerequisite: verifyDockerPrerequisite,
  prepare: (provider, options) => ManagedCliRuntime.prepare(provider, options),
};
export async function runCliCheck(boot: Boot, signal: AbortSignal, emit: (frame: Frame) => void, deps: CheckDependencies = dependencies): Promise<void> {
  let runtime: CheckRuntime | undefined, preparing = false, cleanupVerified = true, version: string | null = null;
  let errorCode: CheckError | null = null;
  emit({type: "progress", phase: "preparing"});
  try {
    signal.throwIfAborted();
    const assets = await deps.assets(boot);
    signal.throwIfAborted();
    await deps.prerequisite(assets, signal);
    signal.throwIfAborted();
    preparing = true; cleanupVerified = false;
    runtime = await deps.prepare(boot.provider, {assets, signal});
    await runtime.start({signal});
    emit({type: "progress", phase: "checking"});
    const result = await runtime.exec([`/opt/cg/${boot.provider}`, "--version"], 15_000, {signal, maxBytes: 4096});
    signal.throwIfAborted();
    const expected = boot.provider === "codex" ? `codex-cli ${pins.binaries.codex.version}` : `${pins.binaries.claude.version} (Claude Code)`;
    if (result.code !== 0 || result.stdout.trim() !== expected) throw new CheckFailure("cli_check_failed");
    version = result.stdout.trim();
  } catch (error) {
    if (error instanceof ManagedPreparationError) cleanupVerified = error.cleanupVerified;
    else if (!preparing) cleanupVerified = true;
    errorCode = signal.aborted ? (signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "worker_failed" ? "worker_failed" : "cancelled") : error instanceof CheckFailure ? error.code : "worker_failed";
  } finally {
    emit({type: "progress", phase: "cleaning"});
    if (runtime) {
      try { await runtime.destroy({signal: AbortSignal.timeout(25_000)}); cleanupVerified = true; }
      catch { cleanupVerified = false; errorCode = "cleanup_failed"; }
    }
    if (signal.aborted && !errorCode) errorCode = signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "worker_failed" ? "worker_failed" : "cancelled";
    emit({type: "result", outcome: !cleanupVerified ? "needs_review" : errorCode === "cancelled" ? "cancelled" : errorCode ? "failed" : "passed",
      cli_version: errorCode || !cleanupVerified ? null : version, error_code: errorCode, cleanup: cleanupVerified ? "verified" : "unknown"});
  }
}
