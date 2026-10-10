import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateJournalContractManifest, journalContractFixturePath, serializeJournalContractManifest } from "./operation-journal-contract.ts";

const contents = serializeJournalContractManifest(await generateJournalContractManifest());
if (process.argv.includes("--check")) {
  assert.equal(await readFile(journalContractFixturePath, "utf8"), contents, "Shared journal fixtures drifted; run the generator and review the contract changes.");
  console.log("Shared operation journal fixtures are current.");
} else {
  await mkdir(path.dirname(journalContractFixturePath), { recursive: true });
  await writeFile(journalContractFixturePath, contents, "utf8");
  console.log(`Wrote shared operation journal fixtures: ${journalContractFixturePath}`);
}
