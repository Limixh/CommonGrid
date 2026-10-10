import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { parseBoot, runCliCheck, selectWindowsDockerEndpoint, verifyAssets, verifyDockerPrerequisite, type Boot, type CheckDependencies, type Frame } from "../../../apps/desktop/native-worker/cli-check.ts";
import { ManagedPreparationError, type ManagedRuntimeAssets } from "../src/managed-runtime.ts";
import pins from "../runtime-assets/native-cli-assets.lock.json";

const boot: Boot = {type: "boot", schema_version: "1.0", request_id: randomUUID(), provider: "codex", journal_root: path.resolve("synthetic-journal"), assets_root: path.resolve("synthetic-assets")};
const assets: ManagedRuntimeAssets = {baseImage: "node@sha256:" + "0".repeat(64), journalRoot: boot.journal_root, bridgeRoot: boot.assets_root,
  binaries: {claude: {binaryPath: path.resolve("claude"), sha256: "0".repeat(64)}, codex: {binaryPath: path.resolve("codex"), sha256: "1".repeat(64)}}};
test("Windows daemon discovery ignores inherited endpoints and pins only a responding local Linux engine", async () => {
  const environment = {DOCKER_HOST: "tcp://SYNTHETIC_UNTRUSTED_ENDPOINT:2375"}, seen: string[] = [];
  await selectWindowsDockerEndpoint(new AbortController().signal, async () => {
    seen.push(environment.DOCKER_HOST);
    return {code: seen.length === 1 ? 1 : 0, stdout: seen.length === 1 ? "" : "linux/amd64\n"};
  }, environment);
  assert.deepEqual(seen, ["npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/docker_engine"]);
  assert.equal(environment.DOCKER_HOST, seen[1]);
  await assert.rejects(selectWindowsDockerEndpoint(new AbortController().signal, async () => ({code: 0, stdout: "windows/amd64"}), environment));
  assert.equal(environment.DOCKER_HOST, undefined);
});
test("aborted Windows discovery cannot probe another endpoint", async () => {
  const controller = new AbortController(), environment = {}, seen: string[] = [];
  await assert.rejects(selectWindowsDockerEndpoint(controller.signal, async () => {
    seen.push("probe"); controller.abort("cancelled"); throw new Error("PRIVATE_PROBE_DETAIL");
  }, environment));
  assert.deepEqual(seen, ["probe"]);
});
function fixture(options: {prepareError?: Error; execError?: Error; cleanupError?: Error; cancel?: AbortController; cleanupAbort?: {controller: AbortController; reason: string}} = {}) {
  const calls: string[] = [], frames: Frame[] = [];
  const dependencies: CheckDependencies = {
    async assets() { calls.push("assets"); return assets; },
    async prerequisite() { calls.push("prerequisite"); },
    async prepare(provider, config) {
      calls.push("prepare"); assert.equal(provider, "codex"); assert.equal(config.assets, assets);
      if (options.prepareError) throw options.prepareError;
      return {
        async start() { calls.push("start"); },
        async exec(argv, timeout, config) {
          calls.push("exec"); assert.deepEqual(argv, ["/opt/cg/codex", "--version"]); assert.equal(timeout, 15_000); assert.equal(config.maxBytes, 4096);
          options.cancel?.abort("cancelled"); if (options.execError) throw options.execError;
          return {code: 0, stdout: "codex-cli 0.157.1\n"};
        },
        async destroy(config) {
          calls.push("destroy"); assert.equal(config.signal.aborted, false, "cleanup inherits no cancelled execution signal");
          if (options.cleanupError) throw options.cleanupError;
          options.cleanupAbort?.controller.abort(options.cleanupAbort.reason);
        },
      };
    },
  };
  return {calls, frames, dependencies};
}
test("missing pinned image is a setup failure before mutation and exposes no Docker stderr", async () => {
  const f = fixture(), commands: string[][] = [];
  f.dependencies.prerequisite = (assets, signal) => verifyDockerPrerequisite(assets, signal, async (args, options) => {
    commands.push(args); assert.equal(options?.timeoutMs, 10_000); assert.equal(options?.maxBytes, 8192);
    return args[0] === "version" ? {code: 0, stdout: "linux/amd64\n", stderr: ""} :
      {code: 1, stdout: "", stderr: "Error response from daemon: No such image: PRIVATE_REFERENCE_OR_LOG"};
  }, "linux");
  await runCliCheck(boot, new AbortController().signal, frame => f.frames.push(frame), f.dependencies);
  assert.deepEqual(commands, [["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], ["image", "inspect", "--format", "{{.Id}}", assets.baseImage]]);
  assert.deepEqual(f.calls, ["assets"]);
  assert.deepEqual(f.frames.at(-1), {type: "result", outcome: "failed", cli_version: null, error_code: "image_missing", cleanup: "verified"});
  assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
});
test("daemon failures and incompatible engines cannot be mistaken for missing images", async () => {
  for (const stage of ["version", "platform", "image"]) {
    const commands: string[] = [], f = fixture();
    f.dependencies.prerequisite = (assets, signal) => verifyDockerPrerequisite(assets, signal, async args => {
      commands.push(args[0]);
      if (stage === "version" || args[0] === "image") return {code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon: PRIVATE_ENDPOINT"};
      return {code: 0, stdout: stage === "platform" ? "windows/amd64" : "linux/amd64", stderr: ""};
    }, "linux");
    await runCliCheck(boot, new AbortController().signal, frame => f.frames.push(frame), f.dependencies);
    assert.deepEqual(commands, stage === "image" ? ["version", "image"] : ["version"]);
    assert.deepEqual(f.calls, ["assets"]);
    assert.deepEqual(f.frames.at(-1), {type: "result", outcome: "failed", cli_version: null, error_code: "docker_unavailable", cleanup: "verified"});
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("native worker accepts only a fixed boot identity and absolute native paths", () => {
  assert.deepEqual(parseBoot(boot), boot);
  for (const value of [{...boot, argv: ["secret"]}, {...boot, assets_root: ".tools"}, {...boot, journal_root: "relative"}, {...boot, provider: "api"}, {...boot, request_id: "invalid"}]) assert.throws(() => parseBoot(value));
});
test("CLI check runs a fixed version argv then independently verifies cleanup before reporting success", async () => {
  const f = fixture(); await runCliCheck(boot, new AbortController().signal, frame => f.frames.push(frame), f.dependencies);
  assert.deepEqual(f.calls, ["assets", "prerequisite", "prepare", "start", "exec", "destroy"]);
  assert.deepEqual(f.frames.at(-1), {type: "result", outcome: "passed", cli_version: "codex-cli 0.157.1", error_code: null, cleanup: "verified"});
});
test("cancelled check keeps cleanup independent and does not expose the earlier CLI output", async () => {
  const controller = new AbortController(), f = fixture({cancel: controller});
  await runCliCheck(boot, controller.signal, frame => f.frames.push(frame), f.dependencies);
  assert.equal(f.calls.at(-1), "destroy");
  assert.deepEqual(f.frames.at(-1), {type: "result", outcome: "cancelled", cli_version: null, error_code: "cancelled", cleanup: "verified"});
});
test("unverified cleanup never becomes success and does not expose private diagnostics", async () => {
  const f = fixture({cleanupError: new Error("PRIVATE_AUTH_PATH_OR_LOG")});
  await runCliCheck(boot, new AbortController().signal, frame => f.frames.push(frame), f.dependencies);
  assert.deepEqual(f.frames.at(-1), {type: "result", outcome: "needs_review", cli_version: null, error_code: "cleanup_failed", cleanup: "unknown"});
  assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
});
test("prepare uncertainty is retained while a verified failed prepare can finish", async () => {
  for (const verified of [true, false]) {
    const f = fixture({prepareError: new ManagedPreparationError(verified, new Error("PRIVATE_MUTATION_FAILURE"))});
    await runCliCheck(boot, new AbortController().signal, frame => f.frames.push(frame), f.dependencies);
    assert.equal(f.calls.includes("exec"), false);
    assert.equal((f.frames.at(-1) as any).outcome, verified ? "failed" : "needs_review");
    assert.equal((f.frames.at(-1) as any).cleanup, verified ? "verified" : "unknown");
    assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("already cancelled boot does not inspect assets or create Docker resources", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort("cancelled");
  await runCliCheck(boot, controller.signal, frame => f.frames.push(frame), f.dependencies);
  assert.deepEqual(f.calls, []); assert.equal((f.frames.at(-1) as any).outcome, "cancelled");
});
test("deadline and CLI failure are bounded public outcomes after cleanup", async () => {
  const controller = new AbortController(), f = fixture();
  f.dependencies.prerequisite = async () => { controller.abort("deadline_exceeded"); throw new Error("PRIVATE"); };
  await runCliCheck(boot, controller.signal, frame => f.frames.push(frame), f.dependencies);
  assert.equal((f.frames.at(-1) as any).error_code, "deadline_exceeded"); assert.equal((f.frames.at(-1) as any).cleanup, "verified");
  const failure = fixture({execError: new Error("PRIVATE_STDERR")});
  await runCliCheck(boot, new AbortController().signal, frame => failure.frames.push(frame), failure.dependencies);
  assert.equal(failure.calls.at(-1), "destroy"); assert.equal((failure.frames.at(-1) as any).outcome, "failed");
});
test("cancel or deadline during cleanup cannot report the earlier version as a passed check", async () => {
  for (const reason of ["cancelled", "deadline_exceeded"]) {
    const controller = new AbortController(), f = fixture({cleanupAbort: {controller, reason}});
    await runCliCheck(boot, controller.signal, frame => f.frames.push(frame), f.dependencies);
    assert.equal((f.frames.at(-1) as any).error_code, reason); assert.equal((f.frames.at(-1) as any).cli_version, null);
    assert.equal((f.frames.at(-1) as any).cleanup, "verified"); assert.notEqual((f.frames.at(-1) as any).outcome, "passed");
  }
});
test("asset directory links are rejected before following a different directory's config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-assets-link-"));
  try {
    const target = path.join(directory, "target"), linked = path.join(directory, "linked"); await mkdir(target);
    await writeFile(path.join(target, "config.json"), JSON.stringify({schema_version: "1.0", base_image: pins.base_image,
      binaries: Object.fromEntries(Object.entries(pins.binaries).map(([id, pin]) => [id, {file: pin.file, sha256: pin.sha256}])), bridges: {}}));
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyAssets({...boot, assets_root: linked}, {}), error => (error as Error).message === "asset_invalid");
    await assert.rejects(verifyAssets({...boot, assets_root: target}, {}), error => (error as Error).message === "asset_missing");
  } finally { await rm(directory, {recursive: true, force: true}); }
});
