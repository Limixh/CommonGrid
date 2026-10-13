import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { artifactLimits, buildArtifactBundle } from "../src/artifact-bundle.ts";
import { createControlledPatch } from "../src/controlled-task.ts";
import { assertSoftwareResultDeliverable, buildSoftwareResultBundle, softwareDeliverabilityLeaseId, type SoftwareResultInput } from "../src/software-result.ts";
import { assertSoftwareCandidate, softwareBaseline, softwareBoundsTaskId } from "../src/software-task.ts";

const readJson = (url: URL) => JSON.parse(readFileSync(url, "utf8"));
const catalog = readJson(new URL("../../task-schema/fixtures/catalog.json", import.meta.url));
const task = () => structuredClone(catalog.tasks.find((item: { id: string }) => item.id === softwareBoundsTaskId));
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const reference = softwareBaseline.replace("values.length - 1", "values.length");
const goTestdata = new URL("../../../services/coordinator/internal/artifact/testdata/", import.meta.url);

function input(candidate = reference, overrides: Partial<SoftwareResultInput> = {}): SoftwareResultInput {
  const created = createControlledPatch(candidate, softwareBaseline, "software-bounds");
  return { baseline: softwareBaseline, strategyId: "invariant", leaseId: "lease-client-fixture", patch: created.patch, candidateSha256: created.candidate_sha256, ...overrides };
}
const code = (expected: string) => (error: unknown) => error instanceof Error && error.message === expected;

test("the reference fix really changes the pinned baseline", () => {
  assert.notEqual(reference, softwareBaseline);
});

test("result bundle is deterministic and carries exactly the verified candidate", async () => {
  const first = await buildSoftwareResultBundle(task(), input()), second = await buildSoftwareResultBundle(task(), input());
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sha256, sha256(first.bytes));
  assert.equal(first.size_bytes, first.bytes.length);
  assert.deepEqual(first.file, { path: "src/search.ts", sha256: sha256(reference), size_bytes: Buffer.byteLength(reference) });
  assert.ok(first.bytes.includes(Buffer.from(reference)), "stored STORE member holds the candidate bytes");
  // Same bytes as building directly from the candidate: the patch path adds nothing.
  const t = task(), direct = await buildArtifactBundle(t, { purpose: "result", task_id: t.id, task_version: t.task_version, contract_hash: t.contract_hash, lease_id: "lease-client-fixture", base_commit: t.workspace.commit, strategy_id: "invariant" }, [{ path: "src/search.ts", bytes: Buffer.from(reference) }], async () => {});
  assert.deepEqual(first.bytes, direct.bytes);
});

test("a different lease or strategy changes the bound manifest", async () => {
  const base = await buildSoftwareResultBundle(task(), input());
  const lease = await buildSoftwareResultBundle(task(), input(reference, { leaseId: "lease-other" }));
  const strategy = await buildSoftwareResultBundle(task(), input(reference, { strategyId: "boundary-first" }));
  assert.notEqual(lease.sha256, base.sha256);
  assert.notEqual(strategy.sha256, base.sha256);
});

test("candidate hash mismatch is a candidate fault", async () => {
  await assert.rejects(buildSoftwareResultBundle(task(), input(reference, { candidateSha256: sha256(softwareBaseline) })), code("candidate_hash_mismatch"));
  await assert.rejects(buildSoftwareResultBundle(task(), input(reference, { candidateSha256: "x" })), code("candidate_hash_mismatch"));
});

test("a patch that does not apply to the baseline is a candidate fault", async () => {
  const created = input();
  await assert.rejects(buildSoftwareResultBundle(task(), { ...created, baseline: softwareBaseline.replace("values.length - 1", "values.length - 2") }), code("candidate_patch_apply_failed"));
  // A patch that still applies but yields different bytes than the verified candidate.
  await assert.rejects(buildSoftwareResultBundle(task(), { ...created, baseline: softwareBaseline + "// drift\n" }), code("candidate_hash_mismatch"));
  await assert.rejects(buildSoftwareResultBundle(task(), { ...created, patch: "not a patch\n" }), code("candidate_patch_apply_failed"));
});

test("only the pinned writable path of a catalog software task is accepted", async () => {
  const wrongPath = task(); wrongPath.workspace.writable_paths = ["src/other.ts"];
  await assert.rejects(buildSoftwareResultBundle(wrongPath, input()), code("result_path_denied"));
  const controlled = task(); controlled.id = "controlled-sum-integers-v1";
  await assert.rejects(buildSoftwareResultBundle(controlled, input()), code("result_task_unsupported"));
  const unknown = task(); unknown.id = "lean-add-comm";
  await assert.rejects(buildSoftwareResultBundle(unknown, input()), code("result_task_unsupported"));
});

test("an unknown strategy is rejected", async () => {
  await assert.rejects(buildSoftwareResultBundle(task(), input(reference, { strategyId: "foreign" })), code("result_strategy_invalid"));
  await assert.rejects(buildSoftwareResultBundle(task(), input(reference, { strategyId: "" })), code("result_strategy_invalid"));
});

test("a tampered contract is not an excuse to build: binding and task checks stay in force", async () => {
  const tampered = task(); tampered.contract_hash = "f".repeat(64);
  await assert.rejects(buildSoftwareResultBundle(tampered, input()), code("artifact_task_invalid"));
  await assert.rejects(buildSoftwareResultBundle(task(), input(reference, { leaseId: "../lease" })), code("artifact_binding_mismatch"));
});

// Pins the policy gap: the worker candidate policy is weaker than the delivery
// text policy, so a verifier-passed candidate can still be undeliverable.
test("a candidate with U+200E passes the worker policy but cannot be delivered", async () => {
  for (const mark of ["‎", "‏", "؜", "\u0085"]) {
    const candidate = reference + `// note${mark}\n`;
    assert.doesNotThrow(() => assertSoftwareCandidate(candidate), `worker policy accepts ${JSON.stringify(mark)}`);
    await assert.rejects(buildSoftwareResultBundle(task(), input(candidate)), code("candidate_not_deliverable"));
    await assert.rejects(assertSoftwareResultDeliverable(task(), withoutLease(input(candidate))), code("candidate_not_deliverable"));
  }
});

// The worker policy already rejects secrets and bidi controls; the contract's
// forbidden patterns are enforced by assertSoftwareCandidate, not the patch builder.
test("a candidate with a forbidden pattern cannot be delivered", async () => {
  const forbidden = reference + "// process.exit\n";
  await assert.rejects(buildSoftwareResultBundle(task(), input(forbidden)), code("candidate_not_deliverable"));
});

function withoutLease(value: SoftwareResultInput) {
  const { leaseId: _unused, ...rest } = value;
  return rest;
}

test("the deliverability gate accepts the reference fix and keeps nothing", async () => {
  assert.equal(await assertSoftwareResultDeliverable(task(), withoutLease(input())), undefined);
  assert.match(softwareDeliverabilityLeaseId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
  await assert.rejects(assertSoftwareResultDeliverable(task(), withoutLease(input(reference, { strategyId: "foreign" }))), code("result_strategy_invalid"));
});

test("the result bundle is far below the artifact limits", async () => {
  const bundle = await buildSoftwareResultBundle(task(), input());
  assert.ok(bundle.size_bytes < 4096, `bundle is ${bundle.size_bytes} bytes`);
  assert.ok(bundle.size_bytes < artifactLimits.archiveBytes / 1000);
  assert.ok(bundle.file.size_bytes < artifactLimits.fileBytes / 100);
});

test("the committed Go golden bundle equals the rebuilt bytes", async () => {
  // Regenerate with: node --import tsx spike/artifact-delivery/create-client-fixture.mts
  const binding = readJson(new URL("software-result-binding.json", goTestdata));
  const goTask = readJson(new URL("client-task.json", goTestdata));
  assert.deepEqual(goTask, task(), "client-task.json follows the current catalog contract");
  const rebuilt = await buildSoftwareResultBundle(task(), input(reference, { strategyId: binding.strategy_id, leaseId: binding.lease_id }));
  const committed = readFileSync(new URL("software-result-bundle.zip", goTestdata));
  assert.deepEqual(rebuilt.bytes, committed);
  assert.equal(binding.purpose, "result");
  assert.equal(binding.task_id, "software-bounds");
  assert.equal(binding.contract_hash, task().contract_hash);
  assert.equal(binding.base_commit, task().workspace.commit);
});
