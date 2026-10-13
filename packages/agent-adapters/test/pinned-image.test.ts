import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPinnedImageReference } from "../src/pinned-image.ts";

const digest = "sha256:" + "a".repeat(64);
test("pinned references drop only an optional tag and preserve repository and exact digest", () => {
  for (const repository of ["node", "library/node", "registry.example.test/team/node", "localhost:5000/team/node", "registry.example.test:443/team/node"]) {
    const canonical = `${repository}@${digest}`;
    assert.equal(canonicalPinnedImageReference(`${repository}:22-bookworm-slim@${digest}`), canonical);
    assert.equal(canonicalPinnedImageReference(canonical), canonical);
  }
  assert.notEqual(canonicalPinnedImageReference(`localhost:5000/team/node:22@${digest}`),
    canonicalPinnedImageReference(`localhost:5001/team/node:22@${digest}`));
  assert.notEqual(canonicalPinnedImageReference(`node:22@${digest}`),
    canonicalPinnedImageReference(`node:22@sha256:${"b".repeat(64)}`));
});

test("unpinned and malformed digest references are rejected without choosing an image", () => {
  for (const value of [undefined, {}, "node", "node:22", "node:latest", "--pull=always", `node@sha512:${"a".repeat(64)}`,
    `node@sha256:${"a".repeat(63)}`, `node@sha256:${"A".repeat(64)}`, `node:@${digest}`, `node:22:other@${digest}`, `node@${digest}\n`,
    `node@${digest}@${digest}`]) {
    assert.throws(() => canonicalPinnedImageReference(value), /^Error: pinned_image_reference_invalid$/);
  }
});
