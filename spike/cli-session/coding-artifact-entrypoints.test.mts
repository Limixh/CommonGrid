import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, access, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
import { runOwnedCommand } from "../../packages/agent-adapters/src/owned-process.ts";
import { baseline, correctCandidate, createDiff, verifyCandidate } from "./coding-task.mts";
import { validateCodingCandidateSource } from "./coding-artifact.mjs";

test("direct verifier rejects unsafe source before allocating any Docker resource", async () => {
  const original = TaskToolsRuntime.create;
  let attempted = false;
  TaskToolsRuntime.create = async () => { attempted = true; throw new Error("unexpected_verifier_staging"); };
  try {
    for (const source of ["// Bearer synthetic-canary-token-value\n", "a\0b", " ".repeat(16385), "\ud800"]) {
      await assert.rejects(() => verifyCandidate(source), /candidate_(?:secret_content|unsafe_content|limit|invalid_utf8)/);
    }
    assert.equal(attempted, false);
  } finally { TaskToolsRuntime.create = original; }
});

test("direct diff rejects secret source before it creates any artifact directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-artifact-diff-"));
  const directory = path.join(root, "rejected");
  try {
    await assert.rejects(() => createDiff("const api_key = 'synthetic_canary_value';\n", directory), /candidate_secret_content/);
    await assert.rejects(() => access(directory), { code: "ENOENT" });
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), "fixture_cleanup_scope");
    assert.ok(path.basename(resolved).startsWith("cg-artifact-diff-"), "fixture_cleanup_scope");
    await rm(resolved, { recursive: true, force: true });
  }
});

test("fixed baseline and correct candidate pass the narrow source policy", () => {
  validateCodingCandidateSource(baseline);
  validateCodingCandidateSource(correctCandidate);
});

test("generated patch roundtrip preserves candidate literals matching Git path prefixes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-artifact-diff-"));
  const source = "const fixturePaths = 'a/before/sum.mjs and b/after/sum.mjs';\n" + correctCandidate;
  try {
    const result = await createDiff(source, root);
    const patch = await readFile(result.patch_file, "utf8");
    assert.ok(patch.includes("+const fixturePaths = 'a/before/sum.mjs and b/after/sum.mjs';\n"));
    assert.equal(result.git_apply_roundtrip, true);
    assert.equal(result.applied_candidate_sha256, result.candidate_sha256);
    const applied = await runOwnedCommand("git", ["-C", path.join(root, "before"), "-c", "core.autocrlf=false", "apply", "--", result.patch_file]);
    assert.equal(applied.code, 0);
    assert.equal(await readFile(path.join(root, "before/sum.mjs"), "utf8"), source);
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), "fixture_cleanup_scope");
    assert.ok(path.basename(resolved).startsWith("cg-artifact-diff-"), "fixture_cleanup_scope");
    await rm(resolved, { recursive: true, force: true });
  }
});

test("ignored nested repository artifacts actually apply instead of exit-zero skipped patches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-artifact-diff-"));
  const source = "const fixturePaths = 'a/before/sum.mjs and b/after/sum.mjs';\n" + correctCandidate;
  const directory = path.join(root, "ignored/artifact");
  try {
    assert.equal((await runOwnedCommand("git", ["-C", root, "init", "--template=", "--initial-branch=fixture"])).code, 0);
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    const result = await createDiff(source, directory);
    assert.equal(result.git_apply_roundtrip, true);
    assert.equal(result.applied_candidate_sha256, result.candidate_sha256);
    assert.equal(await readFile(path.join(directory, "applied/sum.mjs"), "utf8"), source);
    assert.equal(await readFile(path.join(directory, "before/sum.mjs"), "utf8"), baseline);
    assert.equal((await runOwnedCommand("git", ["-C", root, "status", "--porcelain"])).stdout.trim(), "?? .gitignore");
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), "fixture_cleanup_scope");
    assert.ok(path.basename(resolved).startsWith("cg-artifact-diff-"), "fixture_cleanup_scope");
    await rm(resolved, { recursive: true, force: true });
  }
});
