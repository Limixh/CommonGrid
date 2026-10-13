// Reads the pinned software-bounds task bundle and derives its identities.
// Shared by the generator (generate.mjs) and the catalog fixtures
// (create-fixtures.mjs), so the catalog commit can never drift from the files.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { gitFixtureIds } from "../packages/agent-adapters/src/git-object-ids.mjs";

const directory = new URL("../packages/agent-adapters/task-assets/software-bounds/", import.meta.url);
async function walk(url, prefix) {
  const found = [];
  for (const entry of (await readdir(url, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await walk(new URL(entry.name + "/", url), path + "/"));
    else if (entry.isFile()) found.push({path, content: await readFile(new URL(entry.name, url), "utf8")});
    else throw new Error(`Unsupported entry in the software bundle: ${path}`);
  }
  return found;
}
export async function loadSoftwareBundle() {
  const files = await walk(directory, "");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // The bundle is hashed byte for byte; line ending conversion would change ids.
  if (files.some(file => file.content.includes("\r")) || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 12_288)
    throw new Error("The software bundle must use LF endings and stay under 12 KiB.");
  const ids = gitFixtureIds(files);
  return {files: files.map(file => ({...file, sha256: createHash("sha256").update(file.content).digest("hex")})), ids};
}
