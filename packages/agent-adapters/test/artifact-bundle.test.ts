import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contractHash, type TaskContract } from "@commongrid/task-schema";
import { buildArtifactBundle, inspectArtifactText, safeArtifactPath, type ArtifactBinding } from "../src/artifact-bundle.ts";

function task(): TaskContract {
  return structuredClone(JSON.parse(readFileSync(new URL("../../task-schema/fixtures/catalog.json", import.meta.url), "utf8")).tasks[1]);
}
function binding(value: TaskContract): ArtifactBinding {
  return { purpose: "result", task_id: value.id, task_version: value.task_version, contract_hash: value.contract_hash, lease_id: "lease-test", base_commit: value.workspace.commit, strategy_id: value.strategies[0].id };
}
const scan = async () => {};

test("artifact bundle is deterministic and scans only copied allowed files", async () => {
  const value = task(), bytes = Buffer.from("export const lower_bound = () => 0;\n");
  const first = await buildArtifactBundle(value, binding(value), [{ path: "src/search.ts", bytes }], async (files) => { files[0].bytes.fill(0); bytes.fill(0); });
  const second = await buildArtifactBundle(value, binding(value), [{ path: "src/search.ts", bytes: Buffer.from("export const lower_bound = () => 0;\n") }], scan);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.size_bytes, first.bytes.length);
  assert.equal(first.bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(first.bytes.readUInt32LE(first.bytes.length - 22), 0x06054b50);
});

test("artifact binding and writes outside exact contract paths reject before scanning", async () => {
  const value = task(); let scans = 0;
  const scanner = async () => { scans++; };
  const files = [{ path: "src/search.ts", bytes: Buffer.from("const x = 1;\n") }];
  for (const changed of [{ task_version: 9 }, { contract_hash: "f".repeat(64) }, { base_commit: "f".repeat(40) }, { strategy_id: "foreign" }, { lease_id: "../lease" }])
    await assert.rejects(buildArtifactBundle(value, { ...binding(value), ...changed }, files, scanner), /artifact_binding_mismatch/);
  await assert.rejects(buildArtifactBundle(value, binding(value), [{ ...files[0], path: "tests/search.test.ts" }], scanner), /artifact_path_denied/);
  await assert.rejects(buildArtifactBundle(value, binding(value), [{ ...files[0], path: "src/search.ts/child" }], scanner), /artifact_path_denied/);
  assert.equal(scans, 0);
});

test("artifact paths exclude credentials traversal Windows aliases and case collisions", async () => {
  for (const path of ["../source.ts", "/source.ts", "C:/source.ts", "src\\source.ts", ".git/config", ".claude/auth.json", ".env", ".env.local", "src/CON.ts", "src/source.ts.", "src//source.ts", "src/ünicode.ts"])
    assert.equal(safeArtifactPath(path), false, "unsafe path accepted");
  const value = task(); value.workspace.writable_paths = ["src/search.ts", "src/Search.ts"];
  value.contract_hash = await contractHash(value);
  await assert.rejects(buildArtifactBundle(value, binding(value), [{ path: "src/search.ts", bytes: Buffer.from("const x=1;") }, { path: "src/Search.ts", bytes: Buffer.from("const y=2;") }], scan), /artifact_duplicate_path/);
});

test("artifact binary hidden control secret and forbidden content never reaches scanner", async () => {
  const samples = [Buffer.from([0xff]), Buffer.from("text\0hidden"), Buffer.from("// \u0085hidden"), Buffer.from("// \u061chidden"), Buffer.from("// \u200ehidden"), Buffer.from("// \u202ehidden"), Buffer.from("// Bearer SYNTHETIC_CANARY_TOKEN_VALUE"), Buffer.from("// -----BEGIN PRIVATE KEY-----")];
  for (const bytes of samples) assert.throws(() => inspectArtifactText(bytes), /^Error: artifact_(invalid_utf8|unsafe_content|secret_content)$/);
  const value = task(); value.verification.forbidden_patterns = ["SKIP_TESTS"];
  value.contract_hash = await contractHash(value); let called = false;
  await assert.rejects(buildArtifactBundle(value, binding(value), [{ path: "src/search.ts", bytes: Buffer.from("// SKIP_TESTS") }], async () => { called = true; }), /artifact_forbidden_content/);
  assert.equal(called, false);
});

test("artifact text rejects every invisible or format character and accepts honest non-ASCII text", () => {
  const invisible = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069", "\u115f", "\u1160", "\u3164", "\uffa0",
    "\u2028", "\u2029", "\u0085", "\u009f", "\u034f", "\ufe00", "\ufe0f", "\u180b", "\u{e0100}", "\u{e01ef}", "\u{e0001}", "\u{e0020}", "\u{e0041}", "\u{e007f}"];
  for (const character of invisible) for (const text of [`// a${character}b\n`, character + "x", "x" + character]) {
    assert.throws(() => inspectArtifactText(Buffer.from(text)), /^Error: artifact_unsafe_content$/, JSON.stringify(character));
  }
  for (const honest of ["// \u00e7 \u011f \u0131 \u00f6 \u015f \u00fc \u00c7 \u011e \u0130 \u00d6 \u015e \u00dc\n", "const s = 'merhaba \u{1f642} \u4e16\u754c';\r\n\tx();\n", "a\u00a0b"]) assert.equal(inspectArtifactText(Buffer.from(honest)), honest);
});

test("artifact scanner unavailable or failure returns no package and redacts scanner output", async () => {
  const value = task(), files = [{ path: "src/search.ts", bytes: Buffer.from("const x=1;") }];
  await assert.rejects(buildArtifactBundle(value, binding(value), files, undefined as never), /artifact_scanner_unavailable/);
  await assert.rejects(buildArtifactBundle(value, binding(value), files, async () => { throw new Error("PRIVATE_PROVIDER_TOKEN"); }), (error: unknown) => error instanceof Error && error.message === "artifact_scan_failed");
  await assert.rejects(buildArtifactBundle(value, binding(value), [{ ...files[0], bytes: Buffer.alloc(4 * 1024 * 1024 + 1) }], scan), /artifact_file_limit/);
  await assert.rejects(buildArtifactBundle(value, binding(value), [], scan), /artifact_inventory_limit/);
});
