import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deriveCodexCodingCatalog } from "../../../scripts/codex-coding-catalog.mjs";
import { ManagedCliRuntime, validateManagedRuntimeAssets, type ManagedRuntimeAssets } from "../src/managed-runtime.ts";
import { taskRunRequestedModels } from "../src/task-run-protocol.ts";
import pins from "../runtime-assets/native-cli-assets.lock.json";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const source = Buffer.from(JSON.stringify({models: [{slug: "other", tool_mode: "x"}, {slug: "gpt-6-luna", tool_mode: "freeform", multi_agent_version: "v2", experimental_supported_tools: ["a"], base_instructions: "SYNTHETIC"}]}));
const pin = {model: "gpt-6-luna", source_sha256: sha256(source)};

test("pinned catalog derivation is deterministic, direct-tools-only and bound to its source digest", () => {
  const first = deriveCodexCodingCatalog(source, pin), second = deriveCodexCodingCatalog(source, pin);
  assert.deepEqual(first, second); assert.equal(first.sha256, sha256(first.value)); assert.ok(first.value.endsWith("}\n"));
  const catalog = JSON.parse(first.value);
  assert.deepEqual(Object.keys(catalog), ["models"]); assert.equal(catalog.models.length, 1);
  assert.deepEqual([catalog.models[0].slug, catalog.models[0].tool_mode, catalog.models[0].multi_agent_version, catalog.models[0].experimental_supported_tools],
    ["gpt-6-luna", "direct", "disabled", []]);
  assert.throws(() => deriveCodexCodingCatalog(Buffer.concat([source, Buffer.from(" ")]), pin), /codex_catalog_source_mismatch/);
  assert.throws(() => deriveCodexCodingCatalog(source, {...pin, model: "missing"}), /codex_catalog_model_missing/);
});
test("product lock pins the accepted functional-test model and, when the public source is cached, its derived digest", async t => {
  assert.equal(pins.codex_catalog.model, taskRunRequestedModels.codex); assert.match(pins.codex_catalog.sha256, /^[0-9a-f]{64}$/);
  let cached: Buffer;
  try { cached = await readFile(path.resolve(".tools/cli-fixtures/codex-models.json")); } catch { t.skip("public catalog source is not cached"); return; }
  assert.equal(deriveCodexCodingCatalog(cached, pins.codex_catalog).sha256, pins.codex_catalog.sha256);
});
test("runtime assets accept only an exact absolute pinned catalog reference", async () => {
  const assets: ManagedRuntimeAssets = {baseImage: "node:22@sha256:" + "a".repeat(64), bridgeRoot: path.resolve("assets"), journalRoot: path.resolve("journal"),
    binaries: {claude: {binaryPath: path.resolve("claude"), sha256: "b".repeat(64)}, codex: {binaryPath: path.resolve("codex"), sha256: "c".repeat(64)}}};
  const catalog = {filePath: path.resolve("assets", "codex-coding-catalog.json"), sha256: "d".repeat(64)};
  const snapshot = validateManagedRuntimeAssets({...assets, codexCatalog: catalog});
  assert.deepEqual(snapshot.codexCatalog, catalog); assert.ok(Object.isFrozen(snapshot.codexCatalog));
  assert.equal("codexCatalog" in validateManagedRuntimeAssets(assets), false);
  for (const bad of [{...catalog, filePath: "relative.json"}, {...catalog, sha256: "D".repeat(64)}, {...catalog, extra: true}, null, "catalog"])
    assert.throws(() => validateManagedRuntimeAssets({...assets, codexCatalog: bad} as ManagedRuntimeAssets), /managed_runtime_assets_invalid/);
});
test("catalog installation fails before any journal or daemon mutation for missing, tampered or foreign-provider assets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-catalog-install-"));
  try {
    const file = path.join(directory, "codex-coding-catalog.json"); await writeFile(file, "{\"models\":[]}\n");
    const assets: ManagedRuntimeAssets = {baseImage: "node:22@sha256:" + "a".repeat(64), bridgeRoot: directory, journalRoot: path.join(directory, "journal"),
      binaries: {claude: {binaryPath: path.join(directory, "claude"), sha256: "b".repeat(64)}, codex: {binaryPath: path.join(directory, "codex"), sha256: "c".repeat(64)}}};
    const runtime = (provider: "claude" | "codex", extra: Partial<ManagedRuntimeAssets>) => ManagedCliRuntime.restore({owner: randomUUID(), provider}, {assets: {...assets, ...extra}});
    await assert.rejects(runtime("claude", {codexCatalog: {filePath: file, sha256: sha256("{\"models\":[]}\n")}}).installCodexCodingCatalog(), /managed_catalog_provider_invalid/);
    await assert.rejects(runtime("codex", {}).installCodexCodingCatalog(), /managed_catalog_asset_missing/);
    await assert.rejects(runtime("codex", {codexCatalog: {filePath: file, sha256: "0".repeat(64)}}).installCodexCodingCatalog(), /managed_catalog_digest_invalid/);
    await assert.rejects(runtime("codex", {codexCatalog: {filePath: path.join(directory, "absent.json"), sha256: "0".repeat(64)}}).installCodexCodingCatalog(), { code: "ENOENT" });
  } finally { await rm(directory, {recursive: true, force: true}); }
});
