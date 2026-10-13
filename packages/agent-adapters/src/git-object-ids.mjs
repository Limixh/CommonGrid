// Deterministic git object ids (blob, tree, commit) for a small pinned file
// set. Used by the fixture generator and by the runtime bundle check, so both
// derive the synthetic commit id the same way; nothing here touches git itself.
import { createHash } from "node:crypto";

export const gitFixtureIdentity = "CommonGrid Fixtures <fixtures@commongrid.invalid>";
export const gitFixtureEpoch = 1735689600;
export const gitFixtureMessage = "software-bounds pinned task bundle";

const sha1 = (...parts) => {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const object = (kind, body) => sha1(`${kind} ${body.length}\0`, body);
/** @param {string} content @returns {string} */
export function gitBlobId(content) {
  return object("blob", Buffer.from(content, "utf8")).toString("hex");
}
/**
 * Builds nested trees from slash separated paths and returns the root tree id,
 * every sub tree id and the blob id of each file.
 * @param {ReadonlyArray<{path: string, content: string}>} files
 */
export function gitTreeIds(files) {
  const root = new Map();
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) throw new Error("git_tree_path_collision");
    }
    if (node.has(parts.at(-1))) throw new Error("git_tree_path_collision");
    node.set(parts.at(-1), file.content);
  }
  const trees = {};
  const blobs = {};
  const write = (node, prefix) => {
    const entries = [...node].map(([name, value]) => value instanceof Map
      ? {name, mode: "40000", id: write(value, prefix ? `${prefix}/${name}` : name), sortName: `${name}/`}
      : (blobs[prefix ? `${prefix}/${name}` : name] = gitBlobId(value), {name, mode: "100644", id: blobs[prefix ? `${prefix}/${name}` : name], sortName: name}));
    // Git orders tree entries bytewise, comparing directory names with a trailing slash.
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.sortName), Buffer.from(b.sortName)));
    const body = Buffer.concat(entries.map(entry => Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.id, "hex")])));
    const id = object("tree", body).toString("hex");
    trees[prefix] = id;
    return id;
  };
  const tree = write(root, "");
  return {tree, trees, blobs};
}
/** @param {ReadonlyArray<{path: string, content: string}>} files */
export function gitFixtureIds(files) {
  const {tree, trees, blobs} = gitTreeIds(files);
  const stamp = `${gitFixtureIdentity} ${gitFixtureEpoch} +0000`;
  const commit = object("commit", Buffer.from(`tree ${tree}\nauthor ${stamp}\ncommitter ${stamp}\n\n${gitFixtureMessage}\n`, "utf8")).toString("hex");
  return {commit, tree, trees, blobs};
}
