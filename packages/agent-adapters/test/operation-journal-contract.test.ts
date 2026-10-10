import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readOperationJournals } from "../src/operation-journal.ts";
import { projectOperationRecovery } from "../src/operation-recovery.ts";
import { generateJournalContractManifest, journalContractFixturePath, materializeJournalContractCase, readJournalContractCase, serializeJournalContractManifest, type JournalContractManifest } from "../testing/operation-journal-contract.ts";

test("shared native/Node journal contract fixtures reproduce the real writer and fail closed", async () => {
  const committed = await readFile(journalContractFixturePath, "utf8");
  assert.equal(serializeJournalContractManifest(await generateJournalContractManifest()), committed, "Run the shared fixture generator, then review changed bytes and expectations.");
  const manifest = JSON.parse(committed) as JournalContractManifest;
  assert.equal(manifest.schema_version, 1);
  for (const fixture of manifest.cases) assert.deepEqual(await readJournalContractCase(fixture.files), fixture.expected, fixture.name);
  assert.ok(manifest.cases.length >= 80, "Keep the independent schema, canonical-byte, hash-chain and lifecycle cases.");
});

test("raw invalid UTF-8 bytes fail closed before any recovery observations are exposed", async t => {
  const manifest = JSON.parse(await readFile(journalContractFixturePath, "utf8")) as JournalContractManifest;
  const fixture = manifest.cases.find(value => value.name === "begin_process_crash")!;
  const parent = await realpath(os.tmpdir()), temporary = await mkdtemp(path.join(parent, "commongrid-journal-utf8-"));
  assert.equal(path.dirname(temporary), parent);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "journal"); await materializeJournalContractCase(root, fixture.files);
  const filename = path.join(root, Object.keys(fixture.files)[0]);
  const bytes = Buffer.from(Object.values(fixture.files)[0], "utf8");
  bytes[bytes.indexOf("codex")] = 0xff;
  await writeFile(filename, bytes);
  assert.deepEqual(projectOperationRecovery(await readOperationJournals(root)), { ...fixture.expected, status: "blocked", reason: "operation_journal_invalid", operations: [] });
  // A syntactically valid replacement character is still invalid identity metadata.
  assert.equal(bytes.toString("utf8").includes("\ufffd"), true);
  await mkdir(path.join(temporary, "empty"));
  assert.equal((await readOperationJournals(path.join(temporary, "empty"))).status, "available");
});
