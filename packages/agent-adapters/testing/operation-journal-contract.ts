import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOperationJournal, readOperationJournals, type JournalDurability, type JournalIntent, type JournalReceipt, type OperationJournal } from "../src/operation-journal.ts";
import { projectOperationRecovery, type RecoveryStatus } from "../src/operation-recovery.ts";

export interface JournalContractCase { name: string; files: Record<string, string>; expected: RecoveryStatus }
export interface JournalContractManifest { schema_version: 1; cases: JournalContractCase[] }
export const journalContractFixturePath = fileURLToPath(new URL("../test/fixtures/operation-journal-contract.json", import.meta.url));
const fixedUuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const identity = { owner: fixedUuid(1), provider: "codex", operation: fixedUuid(2) };
const directory = `op-${identity.owner}-${identity.operation}`;
const lease = "a".repeat(64), runtime = "b".repeat(64), init = "c".repeat(64), other = "d".repeat(64);
const recordName = (sequence: number) => `${String(sequence).padStart(6, "0")}.json`;
const filename = (sequence: number) => `${directory}/${recordName(sequence)}`;
type Files = JournalContractCase["files"];
// Deliberately loose: adversarial fixture mutations include invalid schemas and fields.
type RawRecord = Record<string, any>;
const sha256 = (body: RawRecord) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
const clone = (files: Files): Files => ({ ...files });

async function temporary<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, "commongrid-journal-contract-"));
  assert.equal(path.dirname(root), parent);
  try { return await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

/** Materialize only declared UTF-8 fixture bytes; an empty case represents a missing store. */
export async function materializeJournalContractCase(root: string, files: Files): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    assert.equal(relative.includes("\\"), false);
    const target = path.resolve(root, relative), checkedRoot = path.resolve(root);
    assert.equal(target.startsWith(`${checkedRoot}${path.sep}`), true);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

export async function readJournalContractCase(files: Files): Promise<RecoveryStatus> {
  return temporary(async temp => {
    const root = path.join(temp, "journal");
    await materializeJournalContractCase(root, files);
    return projectOperationRecovery(await readOperationJournals(root));
  });
}

function rehash(files: Files, durability?: JournalDurability, rechain = true): Files {
  const result: Files = {}, previousByDirectory = new Map<string, string>();
  for (const name of Object.keys(files).sort()) {
    const raw: RawRecord = JSON.parse(files[name]), parent = name.slice(0, name.lastIndexOf("/"));
    const { hash: _hash, ...body } = raw;
    if (rechain) body.previous_hash = previousByDirectory.get(parent) ?? "0".repeat(64);
    if (durability) body.durability = durability;
    const hash = sha256(body);
    result[name] = `${JSON.stringify({ ...body, hash })}\n`;
    previousByDirectory.set(parent, hash);
  }
  return result;
}

function mutate(files: Files, sequence: number, change: (raw: RawRecord) => void, rechain = true): Files {
  const result = clone(files), name = filename(sequence), raw: RawRecord = JSON.parse(result[name]);
  change(raw); result[name] = `${JSON.stringify(raw)}\n`;
  return rehash(result, undefined, rechain);
}

function append(files: Files, event: RawRecord): Files {
  const result = clone(files), sequence = Object.keys(result).length + 1;
  const raw: RawRecord = JSON.parse(result[filename(sequence - 1)]);
  raw.sequence = sequence; raw.event = event; result[filename(sequence)] = `${JSON.stringify(raw)}\n`;
  return rehash(result);
}
const intentEvent = (intent_id: number, action: JournalIntent["action"], role?: JournalIntent["role"], resource_id?: string) => ({ kind: "intent", intent: { intent_id: fixedUuid(intent_id), action, ...(role ? { role } : {}), ...(resource_id ? { resource_id } : {}) } });
const receiptEvent = (intent_id: number, extra: Partial<JournalReceipt> = {}) => ({ kind: "receipt", receipt: { intent_id: fixedUuid(intent_id), outcome: "verified", ...extra } });
const captureEvent = (intent_id: number, resource_id: string) => ({ kind: "capture", capture: { intent_id: fixedUuid(intent_id), resource_id } });

async function writerFiles(work: (journal: OperationJournal) => Promise<void>): Promise<Files> {
  return temporary(async temp => {
    const root = path.join(temp, "journal"), journal = await createOperationJournal(identity, { root });
    await work(journal);
    const files: Files = {};
    for (const name of (await readdir(path.join(root, directory))).sort()) files[`${directory}/${name}`] = await readFile(path.join(root, directory, name), "utf8");
    // The committed contract is independent of the generator host's durability promise.
    return rehash(files, "process_crash");
  });
}

async function acquire(journal: OperationJournal, intent_id = 10) {
  await journal.appendIntent({ intent_id: fixedUuid(intent_id), action: "lease_acquire" });
  await journal.appendCapture({ intent_id: fixedUuid(intent_id), resource_id: lease });
  await journal.appendReceipt({ intent_id: fixedUuid(intent_id), outcome: "verified", lease_id: lease });
}
async function createNamespace(journal: OperationJournal, intent_id = 11, role: "runtime" | "init" = "runtime", resource_id = runtime) {
  await journal.appendIntent({ intent_id: fixedUuid(intent_id), action: "namespace_create", role });
  await journal.appendCapture({ intent_id: fixedUuid(intent_id), resource_id });
  await journal.appendReceipt({ intent_id: fixedUuid(intent_id), outcome: "verified", resource_id });
}

/** Real writer templates plus precisely rehashed malformed records form the shared reader oracle. */
export async function generateJournalContractManifest(): Promise<JournalContractManifest> {
  const begin = await writerFiles(async () => {});
  const acquirePending = await writerFiles(async journal => { await journal.appendIntent({ intent_id: fixedUuid(10), action: "lease_acquire" }); });
  const leaseCaptured = await writerFiles(async journal => {
    await journal.appendIntent({ intent_id: fixedUuid(10), action: "lease_acquire" });
    await journal.appendCapture({ intent_id: fixedUuid(10), resource_id: lease });
  });
  const acquired = await writerFiles(acquire);
  const namespaceCaptured = await writerFiles(async journal => {
    await acquire(journal); await journal.appendIntent({ intent_id: fixedUuid(11), action: "namespace_create", role: "runtime" });
    await journal.appendCapture({ intent_id: fixedUuid(11), resource_id: runtime });
  });
  const namespaceCreated = await writerFiles(async journal => { await acquire(journal); await createNamespace(journal); });
  const execPending = await writerFiles(async journal => {
    await acquire(journal); await createNamespace(journal);
    await journal.appendIntent({ intent_id: fixedUuid(12), action: "namespace_exec", role: "runtime", resource_id: runtime });
  });
  const rejection = await writerFiles(async journal => {
    await journal.appendIntent({ intent_id: fixedUuid(9), action: "lease_acquire" });
    await journal.appendReceipt({ intent_id: fixedUuid(9), outcome: "rejected_before_dispatch" });
    await acquire(journal);
    await journal.appendIntent({ intent_id: fixedUuid(11), action: "namespace_create", role: "init" });
    await journal.appendReceipt({ intent_id: fixedUuid(11), outcome: "rejected_before_dispatch" });
  });
  const complete = await writerFiles(async journal => {
    await acquire(journal); await createNamespace(journal); await createNamespace(journal, 20, "init", init);
    let next = 30;
    for (const [role, resource_id] of [["runtime", runtime], ["init", init]] as const) {
      for (const action of ["namespace_start", "namespace_exec", "namespace_remove"] as const) {
        const intent_id = fixedUuid(next++); await journal.appendIntent({ intent_id, action, role, resource_id });
        await journal.appendReceipt({ intent_id, outcome: "verified", ...(action === "namespace_exec" ? {} : { resource_id }) });
      }
    }
    for (const role of ["tools", "auth"] as const) for (const action of ["volume_create", "volume_remove"] as const) {
      const intent_id = fixedUuid(next++); await journal.appendIntent({ intent_id, action, role }); await journal.appendReceipt({ intent_id, outcome: "verified" });
    }
    for (const action of ["public_install", "public_manifest_publish", "public_checkpoint_publish"] as const) {
      const intent_id = fixedUuid(next++); await journal.appendIntent({ intent_id, action, ...(action === "public_install" ? { role: "tools" as const } : {}) });
      await journal.appendReceipt({ intent_id, outcome: "verified" });
    }
    await journal.appendIntent({ intent_id: fixedUuid(90), action: "lease_release" });
    await journal.appendReceipt({ intent_id: fixedUuid(90), outcome: "verified", lease_id: lease }); await journal.complete();
  });
  assert.equal(Object.keys(begin).length, 1);
  assert.equal(Object.keys(acquirePending).length, 2);
  assert.equal(Object.keys(leaseCaptured).length, 3);
  assert.equal(Object.keys(acquired).length, 4);
  assert.equal(Object.keys(namespaceCaptured).length, 6);
  assert.equal(Object.keys(execPending).length, 8);
  assert.equal(Object.keys(rejection).length, 8);
  assert.equal(Object.keys(complete).length, 39);
  const completedIntents = Object.values(complete).map(value => JSON.parse(value).event).filter(value => value.kind === "intent").map(value => value.intent);
  assert.deepEqual([...new Set(completedIntents.map(value => value.action))].sort(), ["lease_acquire", "lease_release", "namespace_create", "namespace_exec", "namespace_remove", "namespace_start", "public_checkpoint_publish", "public_install", "public_manifest_publish", "volume_create", "volume_remove"]);
  assert.deepEqual([...new Set(completedIntents.map(value => value.role).filter(Boolean))].sort(), ["auth", "init", "runtime", "tools"]);
  const specs: { name: string; files: Files; status: RecoveryStatus["status"]; pending?: number; namespaces?: number; sequence?: number; terminal?: boolean; operationCount?: number }[] = [];
  const valid = (name: string, files: Files, pending: number, namespaces: number, terminal = false) => specs.push({ name, files, status: "available", pending, namespaces, sequence: Object.keys(files).length, terminal });
  const invalid = (name: string, files: Files) => specs.push({ name, files, status: "blocked" });
  specs.push({ name: "missing_store", files: {}, status: "unavailable" });
  for (const [name, files, pending, namespaces, terminal] of [
    ["begin", begin, 0, 0, false], ["lease_intent_pending", acquirePending, 1, 0, false],
    ["lease_capture_pending", leaseCaptured, 1, 0, false], ["lease_acquired", acquired, 0, 0, false],
    ["namespace_capture_pending", namespaceCaptured, 1, 1, false], ["namespace_exec_pending", execPending, 1, 1, false],
    ["rejected_before_dispatch_retry", rejection, 0, 0, false], ["all_actions_and_roles_complete", complete, 0, 2, true],
  ] as const) for (const durability of ["process_crash", "file_and_directory_synced"] as const) valid(`${name}_${durability}`, rehash(files, durability), pending, namespaces, terminal);
  valid("lease_receipt_without_capture", append(acquirePending, receiptEvent(10, { lease_id: lease })), 0, 0);
  valid("namespace_receipt_without_capture", append(append(acquired, intentEvent(11, "namespace_create", "init")), receiptEvent(11, { resource_id: init })), 0, 1);

  invalid("unknown_record_field", mutate(begin, 1, raw => { raw.extra = "synthetic"; }));
  invalid("unknown_identity_field", mutate(begin, 1, raw => { raw.identity.extra = "synthetic"; }));
  invalid("unknown_event_field", mutate(begin, 1, raw => { raw.event.extra = "synthetic"; }));
  invalid("unknown_intent_field", mutate(acquirePending, 2, raw => { raw.event.intent.extra = "synthetic"; }));
  invalid("unknown_receipt_field", mutate(acquired, 4, raw => { raw.event.receipt.extra = "synthetic"; }));
  invalid("unknown_capture_field", mutate(leaseCaptured, 3, raw => { raw.event.capture.extra = "synthetic"; }));
  invalid("schema_wrong", mutate(begin, 1, raw => { raw.schema = 2; }));
  invalid("sequence_wrong", mutate(begin, 1, raw => { raw.sequence = 2; }));
  invalid("durability_unknown", mutate(begin, 1, raw => { raw.durability = "power_loss_guaranteed"; }));
  invalid("durability_changes", mutate(acquired, 4, raw => { raw.durability = "file_and_directory_synced"; }));
  invalid("directory_identity_mismatch", mutate(begin, 1, raw => { raw.identity.operation = fixedUuid(3); }));
  invalid("provider_identity_changes", mutate(acquired, 4, raw => { raw.identity.provider = "claude"; }));
  invalid("uuid_not_v4", mutate(begin, 1, raw => { raw.identity.owner = "00000000-0000-1000-8000-000000000001"; }));
  invalid("provider_invalid", mutate(begin, 1, raw => { raw.identity.provider = "Codex"; }));
  invalid("action_unknown", mutate(acquirePending, 2, raw => { raw.event.intent.action = "secret_dispatch"; }));
  invalid("role_unknown", mutate(namespaceCaptured, 5, raw => { raw.event.intent.role = "daemon"; }));
  invalid("lease_action_has_role", mutate(acquirePending, 2, raw => { raw.event.intent.role = "runtime"; }));
  invalid("lease_action_has_resource", mutate(acquirePending, 2, raw => { raw.event.intent.resource_id = lease; }));
  invalid("namespace_create_has_resource", mutate(namespaceCaptured, 5, raw => { raw.event.intent.resource_id = runtime; }));
  invalid("namespace_role_invalid", mutate(namespaceCaptured, 5, raw => { raw.event.intent.role = "tools"; }));
  invalid("namespace_exec_resource_missing", mutate(execPending, 8, raw => { delete raw.event.intent.resource_id; }));
  invalid("volume_role_invalid", append(acquired, intentEvent(15, "volume_create", "runtime")));
  invalid("volume_has_resource", append(acquired, intentEvent(15, "volume_remove", "tools", runtime)));
  invalid("public_install_role_invalid", append(acquired, intentEvent(15, "public_install", "auth")));
  invalid("manifest_has_role", append(acquired, intentEvent(15, "public_manifest_publish", "tools")));
  invalid("checkpoint_has_resource", append(acquired, intentEvent(15, "public_checkpoint_publish", undefined, runtime)));
  invalid("receipt_outcome_unknown", mutate(acquired, 4, raw => { raw.event.receipt.outcome = "dispatched"; }));
  invalid("receipt_resource_not_hash", mutate(namespaceCreated, 7, raw => { raw.event.receipt.resource_id = "synthetic"; }));
  invalid("capture_resource_uppercase", mutate(leaseCaptured, 3, raw => { raw.event.capture.resource_id = "A".repeat(64); }));
  invalid("capture_without_pending_intent", append(begin, captureEvent(10, lease)));
  invalid("receipt_without_pending_intent", append(begin, receiptEvent(10, { lease_id: lease })));
  invalid("begin_repeated", append(begin, { kind: "begin" }));
  invalid("begin_missing", mutate(begin, 1, raw => { raw.event = intentEvent(10, "lease_acquire"); }));
  invalid("complete_without_released_lease", append(acquired, { kind: "complete" }));
  invalid("complete_with_pending_intent", append(execPending, { kind: "complete" }));
  invalid("event_after_complete", append(complete, intentEvent(100, "lease_acquire")));
  invalid("duplicate_intent", append(acquired, intentEvent(10, "lease_acquire")));
  invalid("duplicate_capture", append(leaseCaptured, captureEvent(10, lease)));
  invalid("duplicate_receipt", append(acquired, receiptEvent(10, { lease_id: lease })));
  invalid("second_pending_acquire", append(acquirePending, intentEvent(12, "lease_acquire")));
  invalid("acquire_after_acquired", append(acquired, intentEvent(12, "lease_acquire")));
  invalid("mutation_before_lease", append(begin, intentEvent(12, "public_checkpoint_publish")));
  invalid("lease_receipt_missing_id", append(leaseCaptured, receiptEvent(10)));
  invalid("lease_receipt_resource_present", append(leaseCaptured, receiptEvent(10, { lease_id: lease, resource_id: lease })));
  invalid("lease_capture_receipt_mismatch", append(leaseCaptured, receiptEvent(10, { lease_id: other })));
  invalid("rejected_capture", append(leaseCaptured, receiptEvent(10, { outcome: "rejected_before_dispatch" })));
  invalid("rejected_receipt_has_resource", append(acquirePending, receiptEvent(10, { outcome: "rejected_before_dispatch", resource_id: lease })));
  invalid("namespace_capture_receipt_mismatch", append(namespaceCaptured, receiptEvent(11, { resource_id: other })));
  invalid("namespace_create_receipt_missing_resource", append(namespaceCaptured, receiptEvent(11)));
  invalid("namespace_receipt_has_lease", append(namespaceCaptured, receiptEvent(11, { resource_id: runtime, lease_id: lease })));
  invalid("namespace_capture_reused_id", append(append(namespaceCreated, intentEvent(12, "namespace_create", "init")), captureEvent(12, runtime)));
  invalid("namespace_receipt_reused_id", append(append(namespaceCreated, intentEvent(12, "namespace_create", "init")), receiptEvent(12, { resource_id: runtime })));
  invalid("namespace_exec_unknown_id", append(namespaceCreated, intentEvent(12, "namespace_exec", "runtime", other)));
  invalid("namespace_exec_wrong_role", append(namespaceCreated, intentEvent(12, "namespace_exec", "init", runtime)));
  invalid("namespace_exec_receipt_wrong_resource", append(execPending, receiptEvent(12, { resource_id: other })));
  invalid("capture_for_exec", append(execPending, captureEvent(12, runtime)));
  invalid("release_with_active_namespace", append(namespaceCreated, intentEvent(90, "lease_release")));
  invalid("release_with_pending_intent", append(namespaceCaptured, intentEvent(90, "lease_release")));
  const releasePending = append(acquired, intentEvent(90, "lease_release"));
  valid("lease_release_pending", releasePending, 1, 0);
  invalid("mutation_after_release_intent", append(releasePending, intentEvent(91, "public_checkpoint_publish")));
  invalid("release_receipt_wrong_lease", append(releasePending, receiptEvent(90, { lease_id: other })));
  invalid("release_receipt_has_resource", append(releasePending, receiptEvent(90, { lease_id: lease, resource_id: lease })));
  const released = append(releasePending, receiptEvent(90, { lease_id: lease }));
  valid("lease_released_nonterminal", released, 0, 0);
  invalid("mutation_after_release_receipt", append(released, intentEvent(91, "public_checkpoint_publish")));
  const removed = append(append(namespaceCreated, intentEvent(12, "namespace_remove", "runtime", runtime)), receiptEvent(12, { resource_id: runtime }));
  invalid("namespace_exec_after_remove", append(removed, intentEvent(13, "namespace_exec", "runtime", runtime)));
  invalid("namespace_recreate_historical_id", append(append(removed, intentEvent(13, "namespace_create", "runtime")), receiptEvent(13, { resource_id: runtime })));

  invalid("hash_changed", { ...begin, [filename(1)]: begin[filename(1)].replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${"e".repeat(64)}"`) });
  invalid("previous_hash_wrong", mutate(acquired, 4, raw => { raw.previous_hash = other; }, false));
  invalid("first_previous_hash_not_zero", mutate(begin, 1, raw => { raw.previous_hash = other; }, false));
  invalid("missing_final_newline", { ...begin, [filename(1)]: begin[filename(1)].trimEnd() });
  invalid("extra_final_newline", { ...begin, [filename(1)]: `${begin[filename(1)]}\n` });
  invalid("crlf_record", { ...begin, [filename(1)]: begin[filename(1)].replace(/\n$/, "\r\n") });
  invalid("pretty_json", { ...begin, [filename(1)]: `${JSON.stringify(JSON.parse(begin[filename(1)]), null, 2)}\n` });
  const rawBegin = JSON.parse(begin[filename(1)]);
  invalid("record_key_order", { ...begin, [filename(1)]: `${JSON.stringify({ hash: rawBegin.hash, ...rawBegin })}\n` });
  invalid("identity_key_order", mutate(begin, 1, raw => { raw.identity = { provider: raw.identity.provider, owner: raw.identity.owner, operation: raw.identity.operation }; }));
  invalid("intent_key_order", mutate(acquirePending, 2, raw => { raw.event.intent = { action: "lease_acquire", intent_id: fixedUuid(10) }; }));
  invalid("receipt_key_order", mutate(acquired, 4, raw => { raw.event.receipt = { lease_id: lease, intent_id: fixedUuid(10), outcome: "verified" }; }));
  invalid("capture_key_order", mutate(leaseCaptured, 3, raw => { raw.event.capture = { resource_id: lease, intent_id: fixedUuid(10) }; }));
  invalid("event_key_order", mutate(acquirePending, 2, raw => { raw.event = { intent: raw.event.intent, kind: "intent" }; }));
  invalid("noncanonical_string_escape", { ...begin, [filename(1)]: begin[filename(1)].replace('"codex"', '"\\u0063odex"') });
  invalid("truncated_json", { ...begin, [filename(1)]: "{\"schema\":1" });
  invalid("oversized_record", { ...begin, [filename(1)]: "x".repeat(8193) });
  invalid("record_gap", { [filename(2)]: begin[filename(1)] });
  invalid("unexpected_pending_file", { ...begin, [`${directory}/.pending-synthetic`]: "synthetic" });
  invalid("unexpected_root_file", { ...begin, "unexpected.json": "synthetic" });
  invalid("noncanonical_operation_directory", { [`operation-${identity.operation}/000001.json`]: begin[filename(1)] });
  const secondDirectory = `op-${identity.owner}-${fixedUuid(3)}`;
  const second = rehash({ [`${secondDirectory}/000001.json`]: JSON.stringify({ ...rawBegin, identity: { ...identity, operation: fixedUuid(3) } }) });
  specs.push({ name: "two_valid_operations_sorted", files: { ...second, ...begin }, status: "available", operationCount: 2 });
  invalid("mixed_catalog_fails_closed", { ...second, ...begin, [filename(1)]: "{truncated" });

  const cases: JournalContractCase[] = [];
  for (const spec of specs) {
    const expected = await readJournalContractCase(spec.files);
    assert.equal(expected.status, spec.status, spec.name);
    assert.equal(expected.execution_enabled, false, spec.name); assert.equal(expected.automatic_recovery, false, spec.name);
    assert.equal(expected.worker_quiescence, "unknown", spec.name); assert.equal(expected.daemon_state, "unknown", spec.name);
    if (spec.status === "available") {
      assert.equal(expected.operations.length, spec.operationCount ?? 1, spec.name);
      if (!spec.operationCount) {
        assert.equal(expected.operations[0].pending_count, spec.pending, spec.name);
        assert.equal(expected.operations[0].recorded_namespace_count, spec.namespaces, spec.name);
        assert.equal(expected.operations[0].last_sequence, spec.sequence, spec.name);
        assert.equal(expected.operations[0].status, spec.terminal ? "recorded_complete" : "needs_review", spec.name);
      }
    } else {
      assert.equal(expected.operations.length, 0, spec.name);
      assert.equal(expected.reason, spec.status === "unavailable" ? "operation_journal_missing" : "operation_journal_invalid", spec.name);
    }
    cases.push({ name: spec.name, files: spec.files, expected });
  }
  assert.equal(new Set(cases.map(value => value.name)).size, cases.length);
  return { schema_version: 1, cases };
}

export const serializeJournalContractManifest = (manifest: JournalContractManifest) => `${JSON.stringify(manifest, null, 2)}\n`;
