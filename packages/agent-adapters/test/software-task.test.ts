import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import { contractHash } from "@commongrid/task-schema";
import { ControlledTaskCleanupError, applyControlledPatch, buildControlledPatch, controlledBaseline, controlledTaskExecDescription, createControlledPatch, type ControlledVerifierDeps } from "../src/controlled-task.ts";
import { taskCandidateSnapshotScript } from "../src/controlled-task-artifact.ts";
import { gitFixtureEpoch, gitFixtureIdentity, gitFixtureIds, gitFixtureMessage } from "../src/git-object-ids.mjs";
import { SoftwareBundleError, assertSoftwareCandidate, lowerBoundOracle, mergeIntervalsOracle, seedSoftwareTask, snapshotSoftwareCandidate, softwareBaseline, softwareBoundsTask, softwareBoundsTaskId, softwareEntryFiles,
  findSoftwareStrategy, softwareForbiddenPatterns, softwareHarnessInstructions, softwareStrategyNotice, softwareHiddenCases, softwareSnapshotScript, softwareSnapshotSpec, softwareTaskPrompt, softwareTestArgv, softwareVerifierCases,
  softwareVisibleTestCount, verifyCatalogSoftwareBundle, verifySoftwareBundle, verifySoftwareCandidate, softwareBoundsSpec, softwareIntervalsBaseline, softwareIntervalsHiddenCases, softwareIntervalsHiddenDriver, softwareIntervalsSpec, softwareIntervalsTask,
  softwareIntervalsTaskId, softwareTaskSpecFor, softwareTaskSpecs, type SoftwareBundlePin, type SoftwareIntervalsCase, type SoftwareTaskSpec } from "../src/software-task.ts";
import { softwareBoundsBundle } from "../src/software-bounds-bundle.generated.ts";
import { softwareIntervalsBundle } from "../src/software-intervals-bundle.generated.ts";
import { DockerCommandError } from "../src/task-runtime.ts";
import { taskRunCatalogPins, taskRunPatchPaths, taskRunStrategyIds, validTaskRunPatch } from "../src/task-run-protocol.ts";

const catalog = JSON.parse(readFileSync(new URL("../../task-schema/fixtures/catalog.json", import.meta.url), "utf8"));
const catalogTask = catalog.tasks.find((task: {id: string}) => task.id === softwareBoundsTaskId);
const image = "node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
// The test runner marks its children; a nested `node --test` would otherwise skip itself.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pinFor = (task = catalogTask): SoftwareBundlePin => ({task_version: task.task_version, contract_hash: task.contract_hash, image});
const fixed = softwareBaseline.replace("values.length - 1", "values.length");
// Passes every visible test but misbehaves on one fixed hidden case ([1,3,5,7,9] with target 10).
const hiddenOnly = fixed.replace("return low;", "return values.length === 5 && target === 10 ? 0 : low;");
async function changed(change: (task: any) => void) {
  const task = structuredClone(catalogTask); change(task); task.contract_hash = await contractHash(task); return task;
}

// ---- Bundle and contract ---------------------------------------------------

const intervalsCatalogTask = catalog.tasks.find((task: {id: string}) => task.id === softwareIntervalsTaskId);
const bundleIdsTest = (bundle: typeof softwareBoundsBundle | typeof softwareIntervalsBundle, task: {workspace: {commit: string}}) => (t: TestContext) => {
  const files = bundle.files.map(file => ({path: file.path, content: file.content}));
  const ids = gitFixtureIds(files);
  assert.equal(ids.commit, bundle.git.commit); assert.equal(ids.tree, bundle.git.tree); assert.deepEqual(ids.blobs, bundle.git.blobs);
  assert.equal(task.workspace.commit, ids.commit);
  for (const file of bundle.files) assert.equal(file.sha256, sha256(file.content));
  assert.ok(files.every(file => !file.content.includes("\r")) && files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= 12_288);
  try { execFileSync("git", ["--version"], {stdio: "ignore"}); } catch { t.skip("git unavailable"); return; }
  const directory = path.join(tmpdir(), `cg-software-git-${process.pid}-${Date.now()}`);
  execFileSync("git", ["init", "-q", directory]);
  try {
    const git = (args: string[], input?: string, env: NodeJS.ProcessEnv = {}) => execFileSync("git", ["-C", directory, "-c", "commit.gpgsign=false", ...args], {input, env: {...process.env, ...env}, encoding: "utf8"}).trim();
    const blob = (name: string) => git(["hash-object", "-w", "--no-filters", "--stdin"], files.find(file => file.path === name)!.content);
    const [source, test] = [files.find(file => file.path.startsWith("src/"))!.path, files.find(file => file.path.startsWith("tests/"))!.path];
    const src = git(["mktree"], `100644 blob ${blob(source)}	${path.basename(source)}
`), tests = git(["mktree"], `100644 blob ${blob(test)}	${path.basename(test)}
`);
    const root = git(["mktree"], `100644 blob ${blob("package.json")}	package.json
040000 tree ${src}	src
040000 tree ${tests}	tests
`);
    const [name, email] = [gitFixtureIdentity.split(" <")[0], gitFixtureIdentity.split(" <")[1].slice(0, -1)], date = `${gitFixtureEpoch} +0000`;
    const commit = git(["commit-tree", root, "-m", gitFixtureMessage], undefined, {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date});
    assert.deepEqual({commit, tree: root, src, tests}, {commit: ids.commit, tree: ids.tree, src: (ids.trees as Record<string, string>).src, tests: (ids.trees as Record<string, string>).tests});
  } finally { execFileSync(process.execPath, ["-e", "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", directory]); }
};
test("bundle ids match the generated file, the catalog commit and real git objects", bundleIdsTest(softwareBoundsBundle, catalogTask));
test("software-intervals bundle ids match the generated file, the catalog commit and real git objects", bundleIdsTest(softwareIntervalsBundle, intervalsCatalogTask));
test("catalog contract binds the bundle, image, limits and verifier policy", async () => {
  const task = await verifySoftwareBundle(softwareBoundsTask, pinFor());
  assert.equal(task.id, softwareBoundsTaskId); assert.equal(task.environment.cpu, 1); assert.equal(task.environment.memory_mb, 256); assert.equal(task.environment.time_limit_sec, 1200);
  assert.deepEqual(task.workspace.entry_files, softwareEntryFiles); assert.deepEqual(task.workspace.writable_paths, ["src/search.ts"]);
  assert.deepEqual(task.verification.forbidden_patterns, softwareForbiddenPatterns);
  assert.equal(task.verification.local_precheck, softwareTestArgv.join(" ")); assert.equal(task.verification.server_command, softwareTestArgv.join(" "));
  assert.ok(task.prompt.includes("values[i] >= target") && task.prompt.includes("values.length")); assert.ok(task.description.includes("values[i] >= target"));
  // The pinned image may also be written with its tag; only the digest and repository count.
  await verifySoftwareBundle(softwareBoundsTask, {...pinFor(), image: "node:22-bookworm-slim@sha256:" + image.split("@sha256:")[1]});
});
test("the lean contracts keep their hashes while the software contract changed", () => {
  const hashes = Object.fromEntries(catalog.tasks.map((task: any) => [task.id, task.contract_hash]));
  assert.equal(hashes["lean-add-comm"], "cfac882ac5614702bd343a3bc7264550f843472ef89668986e64c106adac2024");
  assert.equal(hashes["lean-plan"], "ada2344d99ce0d8b0034fe0cb8c651696fe2a71d8bc2e3267f21fdc50c1560aa");
});
test("appending software-intervals leaves the software-bounds contract and bundle untouched", () => {
  // Guard: the second task was appended after the existing contracts; bounds keeps its hash, commit and order.
  assert.deepEqual(catalog.tasks.map((task: {id: string}) => task.id), ["lean-add-comm", "software-bounds", "lean-plan", "software-intervals"]);
  assert.equal(catalogTask.contract_hash, "4823a3908e60b9bdeebf737c4f1d8c71a53c86981f5a4c6845877ba815f1216d");
  assert.equal(catalogTask.workspace.commit, softwareBoundsBundle.git.commit);
  assert.equal(softwareBoundsBundle.git.commit, "7a06a3ea1880fec11033104223474b8f297cab6c");
});
test("every contract or bundle mismatch is a coded asset_invalid error", async () => {
  const reject = async (value: unknown, pin: SoftwareBundlePin | undefined, reason: string, bundle?: any) => {
    await assert.rejects(verifySoftwareBundle(value, pin, bundle), error => { assert.ok(error instanceof SoftwareBundleError); assert.equal(error.code, "asset_invalid"); assert.equal(error.reason, reason); return true; });
  };
  await reject(softwareBoundsTask, {...pinFor(), contract_hash: "0".repeat(64)}, "pin");
  await reject(softwareBoundsTask, {...pinFor(), task_version: 2}, "pin");
  await reject(softwareBoundsTask, undefined, "pin");
  await reject({...catalogTask, title: "tampered"}, pinFor(), "contract");
  await reject(null, pinFor(), "contract");
  const lean = catalog.tasks.find((task: any) => task.id === "lean-add-comm");
  await reject(lean, pinFor(lean), "identity");
  const variants: Array<[string, (task: any) => void]> = [
    ["commit", task => { task.workspace.commit = "1".repeat(40); }],
    ["paths", task => { task.workspace.entry_files = ["src/search.ts"]; }],
    ["paths", task => { task.workspace.writable_paths = ["src/search.ts", "tests/search.test.ts"]; }],
    ["paths", task => { task.workspace.writable_paths = ["tests/search.test.ts"]; }],
    ["strategies", task => { task.strategies = [task.strategies[0]]; }],
    ["strategies", task => { task.strategies[1].id = "edges"; }],
    ["strategies", task => { task.strategies.reverse(); }],
    ["strategies", task => { task.strategies.push({id: "extra", instructions: "Extra."}); }],
    ["forbidden_patterns", task => { task.verification.forbidden_patterns = []; }],
    ["forbidden_patterns", task => { task.verification.forbidden_patterns = [...softwareForbiddenPatterns, "eval"]; }],
    ["command", task => { task.verification.server_command = "npm test"; }],
    ["command", task => { task.verification.local_precheck = "npm test"; }],
    ["image", task => { task.environment.image = "node@sha256:" + "0".repeat(64); }],
    ["limits", task => { task.environment.cpu = 2; }],
    ["limits", task => { task.environment.memory_mb = 512; }],
    ["limits", task => { task.environment.time_limit_sec = 1800; }],
  ];
  for (const [reason, change] of variants) { const task = await changed(change); await reject(task, pinFor(task), reason); }
  await reject(softwareBoundsTask, {...pinFor(), image: "node@sha256:" + "0".repeat(64)}, "image");
  await reject(softwareBoundsTask, {...pinFor(), image: "not an image"}, "image");
  // Bundle tampering: contents without their digest, and contents that no longer produce the commit.
  const files: Array<{path: string; content: string; sha256: string}> = softwareBoundsBundle.files.map(file => ({...file}));
  files[1] = {...files[1], content: files[1].content + "// x\n"};
  await reject(softwareBoundsTask, pinFor(), "bundle_file", {...softwareBoundsBundle, files});
  files[1] = {...files[1], sha256: sha256(files[1].content)};
  await reject(softwareBoundsTask, pinFor(), "commit", {...softwareBoundsBundle, files});
});
test("the runner pin equals the catalog contract (fails until the orchestrator fills taskRunCatalogPins)", async t => {
  // PLACEHOLDER GUARD: task-run-protocol.ts ships an all-zero hash until the real contract_hash is filled in.
  const pin = taskRunCatalogPins[softwareBoundsTaskId];
  assert.ok(pin, "software-bounds pin missing");
  assert.deepEqual({task_version: pin.task_version, contract_hash: pin.contract_hash}, {task_version: catalogTask.task_version, contract_hash: catalogTask.contract_hash});
  await verifyCatalogSoftwareBundle(image);
  t.diagnostic(`pinned ${pin.contract_hash}`);
});

const harness = 'Workspace: the working directory is /task. Edit only /task/src/search.ts, using only task_exec. The visible tests in /task/tests/search.test.ts and /task/package.json must not be edited, and no other file may be created. Run the visible tests with argv ["node","--experimental-strip-types","--test","tests/search.test.ts"] (Node strips types, so use erasable TypeScript syntax only). Additional independent checks run elsewhere. Report a short completion.';
const notice = "This strategy only guides your approach; it does not change the task or its acceptance criteria.";
const strategyLines = {
  invariant: "Approved strategy (invariant): Yarı açık [lo, hi) aralığının invariantını koru; önce en küçük karşı örneği bul.\n" + notice,
  "boundary-first": "Approved strategy (boundary-first): Önce boş dizi ve uç değerleri incele, ardından tekrar eden değerleri ele al.\n" + notice,
} as const;
test("prompt is the catalog prompt, the delimited contract strategy, then the fixed harness description", () => {
  const prompt = softwareTaskPrompt({prompt: "CATALOG PROMPT"}, {id: "s-1", instructions: "STRATEGY TEXT"});
  assert.equal(prompt, "CATALOG PROMPT\n\nApproved strategy (s-1): STRATEGY TEXT\n" + notice + "\n\n" + softwareHarnessInstructions + "\n\nTask tool contract: " + controlledTaskExecDescription);
  assert.equal(softwareStrategyNotice, notice);
  assert.equal(softwareHarnessInstructions, harness);
});
test("each approved strategy yields its own fixed prompt from the verified contract", async () => {
  const contract = await verifySoftwareBundle(softwareBoundsTask, pinFor());
  assert.deepEqual(contract.strategies.map(item => item.id), [...taskRunStrategyIds[softwareBoundsTaskId]]);
  const prompts = new Set<string>();
  for (const id of ["invariant", "boundary-first"] as const) {
    const strategy = findSoftwareStrategy(contract, id)!, real = softwareTaskPrompt(contract, strategy);
    assert.equal(strategy.id, id);
    assert.equal(real, catalogTask.prompt + "\n\n" + strategyLines[id] + "\n\n" + harness + "\n\nTask tool contract: " + controlledTaskExecDescription);
    assert.ok(real.startsWith(catalogTask.prompt) && real.endsWith(controlledTaskExecDescription) && real.length < 4000 && !real.includes("\0"));
    // Strategy guidance never touches the fixed tool contract or the acceptance wording of the catalog prompt.
    assert.equal(real.split(strategyLines[id]).length, 2); assert.ok(real.includes(harness));
    prompts.add(real);
  }
  assert.equal(prompts.size, 2);
  assert.equal(findSoftwareStrategy(contract, "unknown"), undefined); assert.equal(findSoftwareStrategy(contract, null), undefined);
});

// ---- Seeding and patch -----------------------------------------------------

test("seed writes the pristine bundle exclusively, one exec per file, and a candidate replaces only the writable file", async () => {
  for (const candidate of [undefined, "export const x = 1;\n"]) {
    const calls: string[][] = [];
    await seedSoftwareTask({async exec(argv: string[]) { calls.push(argv); return {code: 0, stdout: "", stderr: ""}; }} as never, candidate);
    assert.equal(calls.length, 3);
    for (const argv of calls) { assert.deepEqual(argv.slice(0, 2), ["node", "-e"]); assert.ok(argv[2].includes("{flag:'wx'}")); assert.equal(argv.length, 4); }
    const written = calls.map(argv => JSON.parse(argv[3]) as [string, string]);
    assert.deepEqual(written.map(([name]) => name), ["package.json", "src/search.ts", "tests/search.test.ts"]);
    for (const [name, text] of written) assert.equal(text, name === "src/search.ts" && candidate !== undefined ? candidate : softwareBoundsBundle.files.find(file => file.path === name)!.content);
  }
  await assert.rejects(seedSoftwareTask({async exec() { return {code: 1, stdout: "", stderr: ""}; }} as never), /software_task_seed_failed/);
});
test("patch for the software task uses its own header and round-trips against the baseline", () => {
  const evidence = createControlledPatch(fixed, softwareBaseline, softwareBoundsTaskId);
  assert.ok(evidence.patch.startsWith("diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts".slice(0, 41)));
  assert.match(evidence.patch, /\n--- a\/src\/search\.ts\n\+\+\+ b\/src\/search\.ts\n@@ /);
  assert.ok(validTaskRunPatch(evidence.patch, softwareBoundsTaskId)); assert.ok(!validTaskRunPatch(evidence.patch));
  assert.equal(applyControlledPatch(softwareBaseline, evidence.patch, softwareBoundsTaskId), fixed);
  assert.throws(() => applyControlledPatch(softwareBaseline, evidence.patch), /candidate_patch_apply_failed/);
  assert.throws(() => buildControlledPatch(softwareBaseline, softwareBaseline, softwareBoundsTaskId), /candidate_unchanged/);
  assert.ok(buildControlledPatch(controlledBaseline.replace("reduce", "reduce"), "x\n").startsWith("diff --git a/sum.mjs b/sum.mjs\n"));
});

// ---- Exporter --------------------------------------------------------------

async function runExporter(setup: (directory: string) => Promise<void> | void, script = softwareSnapshotScript) {
  const root = await mkdtemp(path.join(tmpdir(), "cg-software-export-")), directory = path.join(root, "task"), output: string[] = [];
  try {
    await mkdir(directory); await setup(directory);
    const fs = await import("node:fs"), crypto = await import("node:crypto");
    const map = (value: unknown) => typeof value === "string" && (value === "/task" || value.startsWith("/task/")) ? path.join(directory, value.slice(5)) : value as string;
    const facade = new Proxy(fs, {get(target, property) {
      if (property === "constants") return target.constants;
      // Windows path stats may report dev=0 while handle stats report the volume ID; this models the Linux exporter filesystem.
      if (process.platform === "win32" && ["lstatSync", "fstatSync"].includes(property as string)) return (value: unknown, ...args: unknown[]) => {
        const stat = (target as any)[property](property === "lstatSync" ? map(value) : value, ...args); stat.dev = 0; return stat;
      };
      if (["readdirSync", "lstatSync", "openSync"].includes(property as string)) return (value: unknown, ...args: unknown[]) => (target as any)[property](map(value), ...args);
      return (target as any)[property];
    }});
    vm.runInNewContext(script, {require: (id: string) => id === "node:crypto" ? crypto : facade, Buffer, TextDecoder, console: {log: (value: string) => output.push(value)}}, {timeout: 2000});
    return output;
  } catch (error) { assert.deepEqual(output, [], "nothing reaches stdout before a rejection"); throw error; } finally { await rm(root, {recursive: true, force: true}); }
}
const seedBundle = async (directory: string, candidate?: string) => {
  for (const file of softwareBoundsBundle.files) {
    await mkdir(path.dirname(path.join(directory, file.path)), {recursive: true});
    await writeFile(path.join(directory, file.path), candidate !== undefined && file.path === "src/search.ts" ? candidate : file.content);
  }
};
test("exporter accepts the pristine tree with a baseline or fixed candidate and prints only the writable file", async () => {
  assert.ok(!new RegExp("[\\u202a-\\u202e\\u2066-\\u2069]").test(softwareSnapshotScript));
  assert.deepEqual(await runExporter(directory => seedBundle(directory)), [Buffer.from(softwareBaseline).toString("base64")]);
  assert.deepEqual(await runExporter(directory => seedBundle(directory, fixed)), [Buffer.from(fixed).toString("base64")]);
});
test("exporter rejects every inventory, protected-file and content violation before stdout", async () => {
  const cases: Array<[string, RegExp, (directory: string) => Promise<void>]> = [
    ["extra file", /candidate_inventory/, async d => { await seedBundle(d); await writeFile(path.join(d, "src/extra.ts"), "x"); }],
    ["extra root file", /candidate_inventory/, async d => { await seedBundle(d); await writeFile(path.join(d, "notes.txt"), "x"); }],
    ["extra directory", /candidate_inventory/, async d => { await seedBundle(d); await mkdir(path.join(d, "node_modules")); }],
    ["missing writable file", /candidate_inventory/, async d => { await seedBundle(d); await rm(path.join(d, "src/search.ts")); }],
    ["missing test file", /candidate_inventory/, async d => { await seedBundle(d); await rm(path.join(d, "tests/search.test.ts")); }],
    ["edited test", /candidate_protected_changed/, async d => { await seedBundle(d); await writeFile(path.join(d, "tests/search.test.ts"), softwareBoundsBundle.files[2].content.replace("3)", "4)")); }],
    ["edited package.json", /candidate_protected_changed/, async d => { await seedBundle(d); await writeFile(path.join(d, "package.json"), '{"type":"commonjs"}\n'); }],
    ["oversize candidate", /candidate_type/, async d => { await seedBundle(d, "x".repeat(16385)); }],
    ["bidi candidate", /candidate_unsafe_content/, async d => { await seedBundle(d, fixed + "// ‮ hidden\n"); }],
    ["secret candidate", /candidate_secret_content/, async d => { await seedBundle(d, fixed + "// Bearer synthetic-canary-token-value\n"); }],
    ["invalid UTF-8 candidate", /candidate_invalid_utf8/, async d => { await seedBundle(d); await writeFile(path.join(d, "src/search.ts"), Buffer.from([0xc3, 0x28])); }],
    ["hard link", /candidate_type/, async d => { await seedBundle(d); await link(path.join(d, "src/search.ts"), path.join(d, "src/alias.ts")); }],
  ];
  for (const [name, expected, setup] of cases) await assert.rejects(runExporter(setup), expected, name);
  // Symbolic links need privileges on some Windows hosts; skip only that case.
  let linked = true;
  const symbolic = async (d: string) => { await seedBundle(d); await rm(path.join(d, "src/search.ts")); try { await symlink(path.join(d, "package.json"), path.join(d, "src/search.ts")); } catch { linked = false; throw new Error("candidate_type"); } };
  await assert.rejects(runExporter(symbolic), /candidate_type/, linked ? "symlink" : "symlink unavailable");
});
test("exporter spec must name exactly one writable file and safe unique paths", () => {
  const hash = "a".repeat(64);
  for (const files of [[], [{path: "a", sha256: hash}], [{path: "a", sha256: null}, {path: "b", sha256: null}], [{path: "a", sha256: null}, {path: "a", sha256: hash}], [{path: "../a", sha256: null}],
    [{path: "a", sha256: null}, {path: "b", sha256: "xyz"}], [{path: "/a", sha256: null}], [{path: "a b", sha256: null}]]) assert.throws(() => taskCandidateSnapshotScript({files}), /task_snapshot_spec_invalid/);
  assert.deepEqual(softwareSnapshotSpec.files.map(file => [file.path, file.sha256 === null]), [["package.json", false], ["src/search.ts", true], ["tests/search.test.ts", false]]);
});

function snapshotDocker(stdout: string, calls: string[], seen: {args?: string[]} = {}) {
  return {
    async checked(args: string[]) { calls.push(args[0]); return ""; },
    async command(args: string[]) { calls.push("run"); seen.args = args; return {code: 0, stdout}; },
  };
}
const snapshotRuntime = (calls: string[]) => ({container: "task-container", volume: "task-volume", async inspect() { calls.push("inspect"); return {}; }});
test("snapshot pauses the task, exports through the read-only exporter and applies the host policy", async () => {
  const calls: string[] = [], seen: {args?: string[]} = {};
  const source = await snapshotSoftwareCandidate(snapshotRuntime(calls) as never, "image", snapshotDocker(Buffer.from(fixed).toString("base64") + "\n", calls, seen));
  assert.equal(source, fixed); assert.deepEqual(calls, ["inspect", "pause", "run", "container", "unpause"]);
  const args = seen.args!;
  assert.ok(args.includes("--network") && args[args.indexOf("--network") + 1] === "none" && args.includes("--read-only") && args.some(arg => arg.includes("readonly")));
  assert.equal(args.at(-1), softwareSnapshotScript);
});
test("unchanged, forbidden-pattern and oversize candidates are rejected on the host as candidate_ errors", async () => {
  const run = (text: string) => { const calls: string[] = []; return snapshotSoftwareCandidate(snapshotRuntime(calls) as never, "image", snapshotDocker(Buffer.from(text).toString("base64"), calls)).finally(() => assert.equal(calls.at(-1), "unpause")); };
  await assert.rejects(run(softwareBaseline), /^Error: candidate_unchanged$/);
  for (const pattern of softwareForbiddenPatterns) await assert.rejects(run(fixed + `// ${pattern}\n`), /^Error: candidate_forbidden_pattern$/, pattern);
  await assert.rejects(run(fixed + "// " + "\\n".repeat(7000) + "\n"), /^Error: candidate_limit$/);
  for (const bad of ["a\0b", "// ‮\n"]) assert.throws(() => assertSoftwareCandidate(bad), /candidate_/);
  assertSoftwareCandidate(fixed);
});

// ---- Hidden cases ----------------------------------------------------------

test("hidden cases are sorted integer arrays with fixed edges and random additions; the oracle is the linear scan", () => {
  const first = softwareHiddenCases(), second = softwareHiddenCases();
  assert.equal(first.length, softwareVerifierCases); assert.equal(first.length, 40);
  for (const item of first) {
    assert.deepEqual(Object.keys(item).sort(), ["target", "values"]);
    assert.ok(Number.isSafeInteger(item.target) && item.values.every(Number.isSafeInteger));
    assert.ok(item.values.every((value, index) => index === 0 || item.values[index - 1] <= value));
  }
  assert.ok(first.some(item => item.values.length === 0) && first.some(item => item.values.length === 1) && first.some(item => new Set(item.values).size < item.values.length));
  assert.ok(first.some(item => item.values.length > 0 && item.target > item.values.at(-1)!) && first.some(item => item.values.length > 0 && item.target < item.values[0]));
  assert.notDeepEqual(first.slice(20), second.slice(20));
  assert.deepEqual(softwareHiddenCases(new Uint8Array(64)), softwareHiddenCases(new Uint8Array(64)));
  assert.equal(lowerBoundOracle([], 3), 0); assert.equal(lowerBoundOracle([1, 2, 2, 3], 2), 1); assert.equal(lowerBoundOracle([1, 2], 3), 2); assert.equal(lowerBoundOracle([5], 5), 0);
  assert.equal(lowerBoundOracle([4, 4, 4], 9), 3); assert.equal(lowerBoundOracle([-3, -1], -2), 1);
});

// ---- Verifier --------------------------------------------------------------

// A node-backed stand-in for the offline verifier container. It runs the real
// visible tests and the real hidden driver with the host's Node; only the
// module path in the driver is replaced and exec arguments are interpreted.
function verifierFixture(options: {mutate?: boolean; hiddenOverride?: (stdout: string) => string; spec?: SoftwareTaskSpec} = {}) {
  const spec = options.spec ?? softwareBoundsSpec, calls: string[] = [], state = {dir: "", created: [] as string[], stdin: "", fail: undefined as undefined | "container" | "staging"};
  const deps: ControlledVerifierDeps = {
    async staging() {
      calls.push("staging"); const dir = state.dir = await mkdtemp(path.join(tmpdir(), "cg-software-verifier-"));
      return {volume: "cg-workspace-fixture",
        async exec(argv: string[]) {
          assert.deepEqual(argv.slice(0, 2), ["node", "-e"]); const [name, text] = JSON.parse(argv[3]) as [string, string];
          await mkdir(path.dirname(path.join(dir, name)), {recursive: true}); await writeFile(path.join(dir, name), text, {flag: "wx"}); calls.push("write"); return {code: 0, stdout: "", stderr: ""};
        },
        async close() { calls.push("close"); await rm(dir, {recursive: true, force: true}); if (state.fail === "staging") throw new Error("PRIVATE_STAGING_CLEANUP"); }};
    },
    async checked(args) {
      calls.push(args[0]);
      if (args[0] === "create") state.created = args;
      if (args[0] === "exec") {
        const names = JSON.parse(args.at(-1)!) as string[], out: Record<string, string> = {};
        for (const name of names) out[name] = sha256(await readFile(path.join(state.dir, name)));
        if (options.mutate) out[spec.writablePath] = "0".repeat(64);
        return JSON.stringify(out);
      }
      if (args[0] === "container" && state.fail === "container") throw new Error("PRIVATE_VERIFIER_CLEANUP");
      return "";
    },
    async command(args, commandOptions) {
      if (args.includes("--test-reporter=tap")) {
        calls.push("visible"); assert.equal(args[0], "exec");
        return new Promise(resolve => execFile(process.execPath, args.slice(3), {cwd: state.dir, env: cleanEnv}, (error, stdout) => { resolve({code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout}); }));
      }
      calls.push("hidden"); assert.deepEqual(args.slice(0, 2).concat(args[2]), ["exec", "-i", args[2]]); assert.ok(commandOptions.stdin);
      const driver = args.at(-1)!.replace(`'/task/${spec.writablePath}'`, JSON.stringify(new URL("file:///" + path.join(state.dir, spec.writablePath).replaceAll("\\", "/")).href));
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", driver], {cwd: state.dir, stdio: ["pipe", "pipe", "ignore"]}), out: Buffer[] = [], input: Buffer[] = [];
        child.stdout.on("data", chunk => out.push(chunk)); child.on("error", reject); child.stdin.on("error", () => {});
        child.on("close", code => resolve({code, stdout: options.hiddenOverride ? options.hiddenOverride(Buffer.concat(out).toString()) : Buffer.concat(out).toString()}));
        commandOptions.stdin!.on("data", (chunk: Buffer) => { input.push(chunk); child.stdin.write(chunk); }).on("end", () => { state.stdin = Buffer.concat(input).toString(); child.stdin.end(); });
      });
    },
  };
  return {calls, deps, state};
}
const happyCalls = ["staging", "write", "write", "write", "create", "start", "visible", "hidden", "exec", "container", "close"];
const verdict = (passed: boolean, visible: boolean, hidden: boolean, source: string) => ({passed, cases: 40, visible_tests_passed: visible, hidden_cases_passed: hidden, candidate_sha256: sha256(source)});

test("verifier fails the baseline, accepts a correct fix and separates visible from hidden failures", async () => {
  for (const [name, source, expected] of [["baseline", softwareBaseline, [false, false, false]], ["fixed", fixed, [true, true, true]], ["visible-passing, hidden-failing", hiddenOnly, [false, true, false]]] as const) {
    const f = verifierFixture(), result = await verifySoftwareCandidate(source, image, f.deps);
    assert.deepEqual(result, verdict(expected[0], expected[1], expected[2], source), name);
    assert.deepEqual(f.calls, happyCalls, name);
  }
});
test("verifier container is offline, read-only, unprivileged and mounts the staging volume read-only", async () => {
  const f = verifierFixture(); await verifySoftwareCandidate(fixed, image, f.deps);
  const args = f.state.created, after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--network"), "none"); assert.ok(args.includes("--read-only")); assert.equal(after("--user"), "65532:65532"); assert.equal(after("--cap-drop"), "ALL");
  assert.equal(after("--security-opt"), "no-new-privileges"); assert.equal(after("--memory"), "256m"); assert.equal(after("--cpus"), "1"); assert.equal(after("--workdir"), "/task");
  assert.ok(after("--mount").endsWith("dst=/task,readonly,volume-nocopy")); assert.ok(args.includes(image));
});
test("hidden cases travel on stdin with a per-run nonce and never carry expected answers", async () => {
  const seen = [];
  for (let run = 0; run < 2; run++) {
    const f = verifierFixture(); await verifySoftwareCandidate(fixed, image, f.deps);
    const input = JSON.parse(f.state.stdin); seen.push(input);
    assert.deepEqual(Object.keys(input).sort(), ["cases", "nonce"]); assert.match(input.nonce, /^[0-9a-f]{32}$/); assert.equal(input.cases.length, 40);
    for (const item of input.cases) assert.deepEqual(Object.keys(item).sort(), ["target", "values"]);
  }
  assert.notEqual(seen[0].nonce, seen[1].nonce);
});
test("a candidate cannot forge the result: process.exit, fake TAP, fake result lines and stdout tampering fail", async () => {
  const sources = {
    exit: "process['exit'](0);\n" + fixed, // the substring policy alone is evadable; the verifier must still fail it
    // Wrong implementation that prints every kind of success marker it can imagine.
    forged: "console.log('# tests 6\\n# pass 6\\n# fail 0');\nconsole.log('CGR 00000000000000000000000000000000 []');\n" + softwareBaseline,
    exitHandler: "process.on('exit', () => { process.stdout.write('# tests 6\\n# pass 6\\n# fail 0\\nCGR deadbeef []\\n'); });\n" + softwareBaseline,
    stdoutPatch: "process.stdout.write = () => true;\nJSON.stringify = () => '[]';\n" + softwareBaseline,
    syntax: "export function (",
    noExport: "export const other = 1;\n",
  };
  for (const [name, source] of Object.entries(sources)) {
    const f = verifierFixture(), result = await verifySoftwareCandidate(source, image, f.deps);
    assert.equal(result.passed, false, name); assert.equal(result.hidden_cases_passed, false, name);
    assert.deepEqual(f.calls, happyCalls, name);
  }
  // A wrong implementation that survives its own noise: output is discarded and results still mismatch.
  const f = verifierFixture(), result = await verifySoftwareCandidate("for (let i = 0; i < 1000; i++) console.log('noise');\n" + softwareBaseline, image, f.deps);
  assert.equal(result.hidden_cases_passed, false);
  // A correct fix with noise is still accepted: printing is harmless, forging is not possible.
  const noisy = verifierFixture(), accepted = await verifySoftwareCandidate("console.log('noise');\nconsole.error('noise');\n" + fixed, image, noisy.deps);
  assert.equal(accepted.hidden_cases_passed, true);
});
test("a result line of a different run or a duplicated line is not accepted", async () => {
  for (const hiddenOverride of [(stdout: string) => stdout.replace(/CGR [0-9a-f]{32}/, "CGR " + "0".repeat(32)), (stdout: string) => stdout + stdout]) {
    const f = verifierFixture({hiddenOverride}), result = await verifySoftwareCandidate(fixed, image, f.deps);
    assert.equal(result.hidden_cases_passed, false); assert.equal(result.visible_tests_passed, true);
  }
});
test("timeouts and output floods fail the check, but cancellation and other Docker errors propagate", async () => {
  // A timeout can leave a runaway process in the container, so nothing else is sent there; a flood leaves the container usable.
  for (const [reason, step, expected, tail] of [["timeout", "visible", verdict(false, false, false, fixed), ["visible", "container", "close"]], ["output_limit", "visible", verdict(false, false, true, fixed), ["visible", "hidden", "exec", "container", "close"]],
    ["timeout", "hidden", verdict(false, true, false, fixed), ["visible", "hidden", "container", "close"]], ["output_limit", "hidden", verdict(false, true, false, fixed), ["visible", "hidden", "exec", "container", "close"]]] as const) {
    const f = verifierFixture(), command = f.deps.command;
    f.deps.command = async (args, options) => { if (args.includes("--test-reporter=tap") === (step === "visible")) { f.calls.push(step); throw new DockerCommandError(reason); } return command(args, options); };
    const result = await verifySoftwareCandidate(fixed, image, f.deps);
    assert.deepEqual(result, expected, `${reason} during ${step}`); assert.deepEqual(f.calls.slice(f.calls.indexOf("start") + 1), tail, `${reason} during ${step}`);
  }
  const failing = verifierFixture(); failing.deps.command = async () => { throw new DockerCommandError("failed"); };
  await assert.rejects(verifySoftwareCandidate(fixed, image, failing.deps), error => error instanceof DockerCommandError); assert.equal(failing.calls.at(-1), "close");
  const controller = new AbortController(), cancelled = verifierFixture();
  cancelled.deps.command = async () => { controller.abort("cancelled"); throw new DockerCommandError("timeout"); };
  await assert.rejects(verifySoftwareCandidate(fixed, image, cancelled.deps, controller.signal)); assert.equal(cancelled.calls.at(-1), "close");
});
test("a mutated candidate is detected after the run and everything is still cleaned up", async () => {
  const f = verifierFixture({mutate: true});
  await assert.rejects(verifySoftwareCandidate(fixed, image, f.deps), /verifier_candidate_mutated/);
  assert.deepEqual(f.calls.slice(-3), ["exec", "container", "close"]);
});
test("unsafe candidates never reach Docker and an early abort creates no resource", async () => {
  const f = verifierFixture();
  for (const source of ["// Bearer synthetic-canary-token-value\n", "a\0b", " ".repeat(16385), "\ud800", fixed + "// child_process\n", fixed + "// process.exit\n"]) await assert.rejects(verifySoftwareCandidate(source, image, f.deps), /candidate_/);
  const controller = new AbortController(); controller.abort("cancelled");
  await assert.rejects(verifySoftwareCandidate(fixed, image, f.deps, controller.signal));
  assert.deepEqual(f.calls, []);
});
test("abort during verification still removes the verifier container and staging volume", async () => {
  const controller = new AbortController(), f = verifierFixture(), command = f.deps.command;
  f.deps.command = async (args, options) => { const result = await command(args, options); controller.abort("cancelled"); return result; };
  await assert.rejects(verifySoftwareCandidate(fixed, image, f.deps, controller.signal));
  assert.deepEqual(f.calls.slice(-2), ["container", "close"]); assert.ok(!f.calls.includes("hidden"));
});
test("verifier cleanup failures keep their typed category and every cleanup step is attempted", async () => {
  for (const fault of ["container", "staging"] as const) {
    const f = verifierFixture(); f.state.fail = fault;
    await assert.rejects(verifySoftwareCandidate(fixed, image, f.deps), error => {
      assert.ok(error instanceof ControlledTaskCleanupError); assert.equal(error.scope, "verifier"); assert.equal(error.message, "controlled_verifier_cleanup_failed"); assert.equal(error.errors.length, 1); return true;
    });
    assert.equal(f.calls.at(-1), "close", "staging cleanup runs after a container cleanup failure");
  }
  const f = verifierFixture(), leak = new AggregateError([new Error("PRIVATE")], "sandbox_cleanup_failed");
  f.deps.staging = async () => { throw leak; };
  await assert.rejects(verifySoftwareCandidate(fixed, image, f.deps), error => { assert.ok(error instanceof ControlledTaskCleanupError); assert.deepEqual(error.errors, [leak]); return true; });
  const other = new Error("sandbox_cleanup_failed"); f.deps.staging = async () => { throw other; };
  await assert.rejects(verifySoftwareCandidate(fixed, image, f.deps), error => error === other);
});

// ---- Host Node checks of the pinned bundle itself ---------------------------

test("with the host's Node the pristine visible tests fail on the baseline and pass on the reference fix", async () => {
  assert.ok(softwareVisibleTestCount >= 5);
  const root = await mkdtemp(path.join(tmpdir(), "cg-software-host-"));
  try {
    for (const [source, code] of [[softwareBaseline, 1], [fixed, 0]] as const) {
      await rm(path.join(root, "t"), {recursive: true, force: true}); await seedBundle(path.join(root, "t"), source);
      const result = await new Promise<{code: number; stdout: string}>(resolve => execFile(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", "tests/search.test.ts"], {cwd: path.join(root, "t"), env: cleanEnv}, (error, stdout) => resolve({code: error ? Number((error as {code: unknown}).code) : 0, stdout})));
      assert.equal(result.code, code); assert.match(result.stdout, new RegExp(`^# tests ${softwareVisibleTestCount}$`, "m")); assert.match(result.stdout, new RegExp(`^# fail ${code === 0 ? 0 : 1}$`, "m"));
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
test("the reference fix agrees with the host oracle on every hidden case", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-software-oracle-"));
  try {
    await writeFile(path.join(root, "fixed.ts"), fixed);
    const { lowerBound } = await import(new URL("file:///" + path.join(root, "fixed.ts").replaceAll("\\", "/")).href);
    for (const item of [...softwareHiddenCases(), ...softwareHiddenCases(new Uint8Array(500).map((_, index) => (index * 37 + 11) % 256))]) assert.equal(lowerBound(item.values, item.target), lowerBoundOracle(item.values, item.target));
  } finally { await rm(root, {recursive: true, force: true}); }
});

// ============================================================================
// software-intervals (second pinned catalog task, same flow as software-bounds)
// ============================================================================

const ivSpec = softwareIntervalsSpec;
const ivFixed = softwareIntervalsBaseline
  .replace("const sorted = intervals as Array<[number, number]>;\n  sorted.sort();", "const sorted = [...intervals].sort((a, b) => a[0] - b[0]);")
  .replace("start < last[1]) last[1] = end;", "start <= last[1]) last[1] = Math.max(last[1], end);");
// Passes every visible test (single-digit, non-negative starts) but sorts lexicographically: only hidden cases catch it.
const ivHiddenOnly = ivFixed.replace(".sort((a, b) => a[0] - b[0])", ".sort()");
const ivPin = (task = intervalsCatalogTask): SoftwareBundlePin => ({task_version: task.task_version, contract_hash: task.contract_hash, image});
async function ivChanged(change: (task: any) => void) {
  const task = structuredClone(intervalsCatalogTask); change(task); task.contract_hash = await contractHash(task); return task;
}
const ivSeedBundle = async (directory: string, candidate?: string) => {
  for (const file of softwareIntervalsBundle.files) {
    await mkdir(path.dirname(path.join(directory, file.path)), {recursive: true});
    await writeFile(path.join(directory, file.path), candidate !== undefined && file.path === "src/intervals.ts" ? candidate : file.content);
  }
};

test("software-intervals: the reference fix differs from the baseline and the hidden-only variant is a real variant", () => {
  assert.notEqual(ivFixed, softwareIntervalsBaseline); assert.notEqual(ivHiddenOnly, ivFixed);
  assert.ok(ivFixed.includes("Math.max") && ivHiddenOnly.includes(".sort()") && !ivHiddenOnly.includes("a[0] - b[0]"));
});
test("software-intervals: spec registry is keyed by task id and agrees with the protocol", () => {
  assert.equal(softwareTaskSpecs["software-bounds"], softwareBoundsSpec); assert.equal(softwareTaskSpecs["software-intervals"], ivSpec);
  assert.equal(softwareTaskSpecFor("software-intervals"), ivSpec); assert.equal(softwareTaskSpecFor("software-bounds"), softwareBoundsSpec);
  for (const id of ["controlled-sum-integers-v1", "lean-add-comm", "__proto__", "toString", "constructor", ""]) assert.equal(softwareTaskSpecFor(id), undefined, id);
  for (const spec of Object.values(softwareTaskSpecs)) {
    assert.equal(taskRunPatchPaths[spec.id], spec.writablePath); assert.deepEqual([...spec.entryFiles], [spec.writablePath, spec.visibleTestPath]);
    assert.deepEqual(spec.bundle.files.map(file => file.path), [...spec.bundlePaths]); assert.equal(spec.verifierCases, 40);
    assert.deepEqual([...spec.forbiddenPatterns], ["child_process", "node:fs", "process.exit"]);
  }
  assert.deepEqual([...ivSpec.testArgv], ["node", "--experimental-strip-types", "--test", "tests/intervals.test.ts"]);
  assert.equal(ivSpec.writablePath, "src/intervals.ts"); assert.equal(ivSpec.hidden.maxBytes, 32_768); assert.equal(softwareBoundsSpec.hidden.maxBytes, 16_384);
  assert.equal(ivSpec.hidden.driver, softwareIntervalsHiddenDriver); assert.ok(ivSpec.visibleTestCount >= 6);
  assert.ok(Object.isFrozen(softwareTaskSpecs) && Object.isFrozen(ivSpec));
});
test("software-intervals: catalog contract binds the bundle, image, limits, strategies and verifier policy", async () => {
  const task = await verifySoftwareBundle(softwareIntervalsTask, ivPin(), undefined, ivSpec);
  assert.equal(task.id, "software-intervals"); assert.equal(task.project_id, "runtime-lab"); assert.deepEqual(task.depends_on, []); assert.equal(task.environment.cpu, 1); assert.equal(task.environment.memory_mb, 256); assert.equal(task.environment.time_limit_sec, 1200);
  assert.notEqual(task.node_id, catalogTask.node_id); assert.notEqual(task.workspace.commit, catalogTask.workspace.commit); assert.equal(task.environment.image, catalogTask.environment.image);
  assert.deepEqual(task.workspace.entry_files, ["src/intervals.ts", "tests/intervals.test.ts"]); assert.deepEqual(task.workspace.writable_paths, ["src/intervals.ts"]);
  assert.deepEqual(task.verification.forbidden_patterns, softwareForbiddenPatterns);
  assert.equal(task.verification.local_precheck, "node --experimental-strip-types --test tests/intervals.test.ts"); assert.equal(task.verification.server_command, task.verification.local_precheck);
  assert.deepEqual(task.strategies.map(item => item.id), ["sort-first", "sweep"]);
  assert.ok(task.prompt.includes("mergeIntervals") && task.prompt.includes("[1, 3] ile [3, 5]") && task.prompt.includes("YENİ")); assert.ok(task.description.includes("mergeIntervals"));
  await verifySoftwareBundle(softwareIntervalsTask, {...ivPin(), image: "node:22-bookworm-slim@sha256:" + image.split("@sha256:")[1]}, undefined, ivSpec);
  // The bounds contract does not verify as intervals and vice versa (identity), and the default spec stays bounds.
  await assert.rejects(verifySoftwareBundle(softwareIntervalsTask, ivPin()), error => error instanceof SoftwareBundleError && error.reason === "identity");
  await assert.rejects(verifySoftwareBundle(softwareBoundsTask, pinFor(), undefined, ivSpec), error => error instanceof SoftwareBundleError && error.reason === "identity");
});
test("software-intervals: every contract or bundle mismatch is a coded asset_invalid error", async () => {
  const reject = async (value: unknown, pin: SoftwareBundlePin | undefined, reason: string, bundle?: any) => {
    await assert.rejects(verifySoftwareBundle(value, pin, bundle, ivSpec), error => { assert.ok(error instanceof SoftwareBundleError); assert.equal(error.code, "asset_invalid"); assert.equal(error.reason, reason); return true; });
  };
  await reject(softwareIntervalsTask, {...ivPin(), contract_hash: "0".repeat(64)}, "pin");
  await reject(softwareIntervalsTask, {...ivPin(), task_version: 2}, "pin");
  await reject(softwareIntervalsTask, undefined, "pin");
  await reject({...intervalsCatalogTask, title: "tampered"}, ivPin(), "contract");
  await reject(null, ivPin(), "contract");
  const variants: Array<[string, (task: any) => void]> = [
    ["commit", task => { task.workspace.commit = "1".repeat(40); }],
    ["commit", task => { task.workspace.commit = catalogTask.workspace.commit; }],
    ["paths", task => { task.workspace.entry_files = ["src/intervals.ts"]; }],
    ["paths", task => { task.workspace.entry_files = ["src/search.ts", "tests/search.test.ts"]; }],
    ["paths", task => { task.workspace.writable_paths = ["src/intervals.ts", "tests/intervals.test.ts"]; }],
    ["paths", task => { task.workspace.writable_paths = ["tests/intervals.test.ts"]; }],
    ["strategies", task => { task.strategies = [task.strategies[0]]; }],
    ["strategies", task => { task.strategies = catalogTask.strategies; }],
    ["strategies", task => { task.strategies.reverse(); }],
    ["strategies", task => { task.strategies.push({id: "extra", instructions: "Extra."}); }],
    ["forbidden_patterns", task => { task.verification.forbidden_patterns = []; }],
    ["command", task => { task.verification.server_command = "node --experimental-strip-types --test tests/search.test.ts"; }],
    ["command", task => { task.verification.local_precheck = "npm test"; }],
    ["image", task => { task.environment.image = "node@sha256:" + "0".repeat(64); }],
    ["limits", task => { task.environment.cpu = 2; }],
    ["limits", task => { task.environment.memory_mb = 512; }],
    ["limits", task => { task.environment.time_limit_sec = 1800; }],
  ];
  for (const [reason, change] of variants) { const task = await ivChanged(change); await reject(task, ivPin(task), reason); }
  const files: Array<{path: string; content: string; sha256: string}> = softwareIntervalsBundle.files.map(file => ({...file}));
  files[1] = {...files[1], content: files[1].content + "// x\n"};
  await reject(softwareIntervalsTask, ivPin(), "bundle_file", {...softwareIntervalsBundle, files});
  files[1] = {...files[1], sha256: sha256(files[1].content)};
  await reject(softwareIntervalsTask, ivPin(), "commit", {...softwareIntervalsBundle, files});
  // Wrong file inventory (same contents under another name) is caught before the contract paths.
  const renamed = softwareIntervalsBundle.files.map(file => file.path === "src/intervals.ts" ? {...file, path: "src/other.ts"} : {...file});
  await reject(softwareIntervalsTask, ivPin(), "commit", {...softwareIntervalsBundle, files: renamed});
});
test("software-intervals: the runner pin equals the catalog contract and verifies the shipped entry", async t => {
  const pin = taskRunCatalogPins[softwareIntervalsTaskId];
  assert.ok(pin, "software-intervals pin missing");
  assert.deepEqual({task_version: pin.task_version, contract_hash: pin.contract_hash}, {task_version: intervalsCatalogTask.task_version, contract_hash: intervalsCatalogTask.contract_hash});
  assert.notEqual(pin.contract_hash, taskRunCatalogPins[softwareBoundsTaskId]!.contract_hash); assert.notEqual(pin.contract_hash, "0".repeat(64));
  assert.equal(await contractHash(intervalsCatalogTask), pin.contract_hash);
  await verifyCatalogSoftwareBundle(image, ivSpec);
  await assert.rejects(verifyCatalogSoftwareBundle(image, ivSpec).then(() => verifyCatalogSoftwareBundle("node@sha256:" + "0".repeat(64), ivSpec)), error => error instanceof SoftwareBundleError && error.reason === "image");
  t.diagnostic(`pinned ${pin.contract_hash}`);
});

const ivHarness = 'Workspace: the working directory is /task. Edit only /task/src/intervals.ts, using only task_exec. The visible tests in /task/tests/intervals.test.ts and /task/package.json must not be edited, and no other file may be created. Run the visible tests with argv ["node","--experimental-strip-types","--test","tests/intervals.test.ts"] (Node strips types, so use erasable TypeScript syntax only). Additional independent checks run elsewhere. Report a short completion.';
const ivStrategyLines = {
  "sort-first": "Approved strategy (sort-first): Önce aralıkları girdiyi değiştirmeden bir kopya üzerinde start değerine göre sayısal olarak sırala; ardından tek geçişte her aralığı son birleştirilen aralıkla karşılaştır.\n" + notice,
  sweep: "Approved strategy (sweep): Uç noktaları tek bir tarama ile işle: açık aralık sayısını izle, aynı koordinatta başlangıçları bitişlerden önce işle ve sayaç sıfıra indiğinde birleşik aralığı kapat.\n" + notice,
} as const;
test("software-intervals: each approved strategy yields its own fixed prompt from the verified contract", async () => {
  assert.equal(ivSpec.harnessInstructions, ivHarness); assert.notEqual(ivHarness, harness);
  const contract = await verifySoftwareBundle(softwareIntervalsTask, ivPin(), undefined, ivSpec);
  assert.deepEqual(contract.strategies.map(item => item.id), [...taskRunStrategyIds[softwareIntervalsTaskId]]);
  const prompts = new Set<string>();
  for (const id of ["sort-first", "sweep"] as const) {
    const strategy = findSoftwareStrategy(contract, id)!, real = softwareTaskPrompt(contract, strategy, ivSpec);
    assert.equal(strategy.id, id);
    assert.equal(real, intervalsCatalogTask.prompt + "\n\n" + ivStrategyLines[id] + "\n\n" + ivHarness + "\n\nTask tool contract: " + controlledTaskExecDescription);
    assert.ok(real.startsWith(intervalsCatalogTask.prompt) && real.endsWith(controlledTaskExecDescription) && real.length < 4000 && !real.includes("\0"));
    assert.equal(real.split(ivStrategyLines[id]).length, 2); assert.ok(real.includes(ivHarness) && !real.includes("src/search.ts"));
    prompts.add(real);
  }
  assert.equal(prompts.size, 2);
  // The default spec keeps the bounds harness, so the two tasks never share instructions.
  assert.ok(softwareTaskPrompt(contract, findSoftwareStrategy(contract, "sweep")!).includes("src/search.ts"));
  assert.equal(findSoftwareStrategy(contract, "invariant"), undefined);
});

test("software-intervals: seed writes the pristine bundle exclusively and a candidate replaces only src/intervals.ts", async () => {
  for (const candidate of [undefined, "export const x = 1;\n"]) {
    const calls: string[][] = [];
    await seedSoftwareTask({async exec(argv: string[]) { calls.push(argv); return {code: 0, stdout: "", stderr: ""}; }} as never, candidate, ivSpec);
    assert.equal(calls.length, 3);
    for (const argv of calls) { assert.deepEqual(argv.slice(0, 2), ["node", "-e"]); assert.ok(argv[2].includes("{flag:'wx'}")); assert.equal(argv.length, 4); }
    const written = calls.map(argv => JSON.parse(argv[3]) as [string, string]);
    assert.deepEqual(written.map(([name]) => name), ["package.json", "src/intervals.ts", "tests/intervals.test.ts"]);
    for (const [name, text] of written) assert.equal(text, name === "src/intervals.ts" && candidate !== undefined ? candidate : softwareIntervalsBundle.files.find(file => file.path === name)!.content);
  }
  await assert.rejects(seedSoftwareTask({async exec() { return {code: 1, stdout: "", stderr: ""}; }} as never, undefined, ivSpec), /software_task_seed_failed/);
});
test("software-intervals: the patch targets src/intervals.ts and round-trips against the baseline", () => {
  const evidence = createControlledPatch(ivFixed, softwareIntervalsBaseline, softwareIntervalsTaskId);
  assert.ok(evidence.patch.startsWith("diff --git a/src/intervals.ts b/src/intervals.ts\n"));
  assert.match(evidence.patch, /\n--- a\/src\/intervals\.ts\n\+\+\+ b\/src\/intervals\.ts\n@@ /);
  assert.ok(validTaskRunPatch(evidence.patch, softwareIntervalsTaskId)); assert.ok(!validTaskRunPatch(evidence.patch)); assert.ok(!validTaskRunPatch(evidence.patch, softwareBoundsTaskId));
  assert.equal(applyControlledPatch(softwareIntervalsBaseline, evidence.patch, softwareIntervalsTaskId), ivFixed);
  assert.throws(() => applyControlledPatch(softwareIntervalsBaseline, evidence.patch, softwareBoundsTaskId), /candidate_patch_apply_failed/);
  assert.throws(() => buildControlledPatch(softwareIntervalsBaseline, softwareIntervalsBaseline, softwareIntervalsTaskId), /candidate_unchanged/);
});

test("software-intervals: exporter accepts the pristine tree with a baseline or fixed candidate and prints only the writable file", async () => {
  assert.ok(!new RegExp("[\\u202a-\\u202e\\u2066-\\u2069]").test(ivSpec.snapshotScript));
  assert.deepEqual(await runExporter(directory => ivSeedBundle(directory), ivSpec.snapshotScript), [Buffer.from(softwareIntervalsBaseline).toString("base64")]);
  assert.deepEqual(await runExporter(directory => ivSeedBundle(directory, ivFixed), ivSpec.snapshotScript), [Buffer.from(ivFixed).toString("base64")]);
  assert.deepEqual(ivSpec.snapshotSpec.files.map(file => [file.path, file.sha256 === null]), [["package.json", false], ["src/intervals.ts", true], ["tests/intervals.test.ts", false]]);
  // The bounds exporter does not accept the intervals tree.
  await assert.rejects(runExporter(directory => ivSeedBundle(directory)), /candidate_inventory/);
});
test("software-intervals: exporter rejects every inventory, protected-file and content violation before stdout", async () => {
  const run = (setup: (directory: string) => Promise<void>) => runExporter(setup, ivSpec.snapshotScript);
  const cases: Array<[string, RegExp, (directory: string) => Promise<void>]> = [
    ["extra file", /candidate_inventory/, async d => { await ivSeedBundle(d); await writeFile(path.join(d, "src/extra.ts"), "x"); }],
    ["extra root file", /candidate_inventory/, async d => { await ivSeedBundle(d); await writeFile(path.join(d, "notes.txt"), "x"); }],
    ["extra directory", /candidate_inventory/, async d => { await ivSeedBundle(d); await mkdir(path.join(d, "node_modules")); }],
    ["bounds file in the intervals tree", /candidate_inventory/, async d => { await ivSeedBundle(d); await writeFile(path.join(d, "src/search.ts"), "x"); }],
    ["missing writable file", /candidate_inventory/, async d => { await ivSeedBundle(d); await rm(path.join(d, "src/intervals.ts")); }],
    ["missing test file", /candidate_inventory/, async d => { await ivSeedBundle(d); await rm(path.join(d, "tests/intervals.test.ts")); }],
    ["edited test", /candidate_protected_changed/, async d => { await ivSeedBundle(d); await writeFile(path.join(d, "tests/intervals.test.ts"), softwareIntervalsBundle.files[2].content.replace("[[1, 5]]", "[[1, 6]]")); }],
    ["edited package.json", /candidate_protected_changed/, async d => { await ivSeedBundle(d); await writeFile(path.join(d, "package.json"), '{"type":"commonjs"}\n'); }],
    ["oversize candidate", /candidate_type/, async d => { await ivSeedBundle(d, "x".repeat(16385)); }],
    ["bidi candidate", /candidate_unsafe_content/, async d => { await ivSeedBundle(d, ivFixed + "// ‮ hidden\n"); }],
    ["secret candidate", /candidate_secret_content/, async d => { await ivSeedBundle(d, ivFixed + "// Bearer synthetic-canary-token-value\n"); }],
    ["invalid UTF-8 candidate", /candidate_invalid_utf8/, async d => { await ivSeedBundle(d); await writeFile(path.join(d, "src/intervals.ts"), Buffer.from([0xc3, 0x28])); }],
    ["hard link", /candidate_type/, async d => { await ivSeedBundle(d); await link(path.join(d, "src/intervals.ts"), path.join(d, "src/alias.ts")); }],
  ];
  for (const [name, expected, setup] of cases) await assert.rejects(run(setup), expected, name);
});
test("software-intervals: snapshot pauses the task, exports through the read-only exporter and applies the host policy", async () => {
  const calls: string[] = [], seen: {args?: string[]} = {};
  const source = await snapshotSoftwareCandidate(snapshotRuntime(calls) as never, "image", snapshotDocker(Buffer.from(ivFixed).toString("base64") + "\n", calls, seen), ivSpec);
  assert.equal(source, ivFixed); assert.deepEqual(calls, ["inspect", "pause", "run", "container", "unpause"]);
  assert.equal(seen.args!.at(-1), ivSpec.snapshotScript); assert.notEqual(ivSpec.snapshotScript, softwareSnapshotScript);
  assert.ok(seen.args!.includes("--read-only") && seen.args![seen.args!.indexOf("--network") + 1] === "none");
});
test("software-intervals: unchanged, forbidden-pattern and oversize candidates are rejected on the host as candidate_ errors", async () => {
  const run = (text: string) => { const calls: string[] = []; return snapshotSoftwareCandidate(snapshotRuntime(calls) as never, "image", snapshotDocker(Buffer.from(text).toString("base64"), calls), ivSpec).finally(() => assert.equal(calls.at(-1), "unpause")); };
  await assert.rejects(run(softwareIntervalsBaseline), /^Error: candidate_unchanged$/);
  // The bounds baseline is not this task's baseline: it is a changed (and thus not "unchanged") candidate for the intervals exporter.
  await assert.doesNotReject(run(ivFixed));
  for (const pattern of softwareForbiddenPatterns) await assert.rejects(run(ivFixed + `// ${pattern}\n`), /^Error: candidate_forbidden_pattern$/, pattern);
  await assert.rejects(run(ivFixed + "// " + "\\n".repeat(7000) + "\n"), /^Error: candidate_limit$/);
  for (const bad of ["a\0b", "// ‮\n"]) assert.throws(() => assertSoftwareCandidate(bad, ivSpec), /candidate_/);
  assertSoftwareCandidate(ivFixed, ivSpec);
});

// ---- Hidden cases and oracle -------------------------------------------------

// A deliberately different algorithm than the oracle: repeatedly merge any two intersecting closed intervals.
function pairwiseMerge(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  let work = intervals.map(([start, end]): [number, number] => [start, end]), changed = true;
  while (changed) {
    changed = false;
    outer: for (let first = 0; first < work.length; first++) for (let second = first + 1; second < work.length; second++) {
      const [a, b] = [work[first], work[second]];
      if (Math.max(a[0], b[0]) <= Math.min(a[1], b[1])) {
        work = work.filter((_, index) => index !== first && index !== second); work.push([Math.min(a[0], b[0]), Math.max(a[1], b[1])]); changed = true; break outer;
      }
    }
  }
  return work.sort((a, b) => a[0] - b[0]);
}
test("software-intervals: hidden cases are valid interval lists with fixed edges and random additions", () => {
  const first = softwareIntervalsHiddenCases(), second = softwareIntervalsHiddenCases();
  assert.equal(first.length, ivSpec.verifierCases); assert.equal(first.length, 40);
  for (const item of first) {
    assert.deepEqual(Object.keys(item), ["intervals"]);
    for (const pair of item.intervals) { assert.equal(pair.length, 2); assert.ok(pair.every(Number.isSafeInteger) && pair[0] <= pair[1]); }
    assert.ok(item.intervals.length <= 16);
  }
  const any = (predicate: (item: SoftwareIntervalsCase) => boolean) => assert.ok(first.some(predicate));
  any(item => item.intervals.length === 0); any(item => item.intervals.length === 1);
  any(item => item.intervals.some((a, i) => item.intervals.some((b, j) => i !== j && a[1] === b[0] && a[0] !== b[0])));            // touching
  any(item => item.intervals.some((a, i) => item.intervals.some((b, j) => i !== j && a[0] < b[0] && b[1] < a[1])));                // nested
  any(item => item.intervals.some((a, i) => i > 0 && a[0] < item.intervals[i - 1][0]));                                            // unsorted
  any(item => new Set(item.intervals.map(pair => pair.join())).size < item.intervals.length);                                      // duplicates
  any(item => item.intervals.some(pair => pair[0] < 0)); any(item => item.intervals.some(pair => pair[0] >= 10 && pair[0] < 100));  // negatives, multi-digit
  any(item => item.intervals.some(pair => pair[1] === Number.MAX_SAFE_INTEGER)); any(item => item.intervals.some(pair => pair[0] === Number.MIN_SAFE_INTEGER));
  any(item => item.intervals.some((a, i) => item.intervals.some((b, j) => i !== j && a[1] + 1 === b[0])));                         // adjacent integers stay separate
  assert.notDeepEqual(first.slice(21), second.slice(21));
  assert.deepEqual(softwareIntervalsHiddenCases(new Uint8Array(64)), softwareIntervalsHiddenCases(new Uint8Array(64)));
  // Fixed cases are copies: changing a returned case never changes the next call.
  first[3].intervals[0][0] = 99; assert.notEqual(softwareIntervalsHiddenCases()[3].intervals[0][0], 99);
  // Output budget: the oracle answer for any random seed fits well inside the hidden exec cap.
  for (let seed = 0; seed < 50; seed++) {
    const cases = softwareIntervalsHiddenCases(new Uint8Array(2048).map((_, index) => (index * (seed + 3) + seed * 7) % 256));
    assert.ok(Buffer.byteLength(JSON.stringify(cases.map(item => mergeIntervalsOracle(item.intervals)))) + 64 < ivSpec.hidden.maxBytes);
  }
});
test("software-intervals: the oracle merges overlapping and touching closed intervals, sorts, and never modifies the input", () => {
  const input: Array<[number, number]> = [[8, 10], [1, 3], [2, 6], [15, 18], [17, 20], [6, 7]];
  const frozen = structuredClone(input); Object.freeze(input); input.forEach(pair => Object.freeze(pair));
  assert.deepEqual(mergeIntervalsOracle(input), [[1, 7], [8, 10], [15, 20]]); assert.deepEqual(input, frozen);
  assert.deepEqual(mergeIntervalsOracle([]), []); assert.deepEqual(mergeIntervalsOracle([[5, 5]]), [[5, 5]]);
  assert.deepEqual(mergeIntervalsOracle([[1, 3], [3, 5]]), [[1, 5]]); assert.deepEqual(mergeIntervalsOracle([[3, 5], [1, 3]]), [[1, 5]]);
  assert.deepEqual(mergeIntervalsOracle([[1, 2], [3, 4]]), [[1, 2], [3, 4]]); assert.deepEqual(mergeIntervalsOracle([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
  assert.deepEqual(mergeIntervalsOracle([[10, 12], [9, 11]]), [[9, 12]]); assert.deepEqual(mergeIntervalsOracle([[-1, 2], [-10, -3]]), [[-10, -3], [-1, 2]]);
  assert.deepEqual(mergeIntervalsOracle([[Number.MIN_SAFE_INTEGER, 0], [0, Number.MAX_SAFE_INTEGER]]), [[Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]);
  const result = mergeIntervalsOracle(input); assert.notEqual(result[0], input[0]);
  // Cross-check with a different algorithm over the hidden cases and many random seeds.
  for (let seed = 0; seed < 30; seed++) for (const item of softwareIntervalsHiddenCases(new Uint8Array(2048).map((_, index) => (index * (seed + 5) + seed * 13) % 256)))
    if (item.intervals.length <= 16 && item.intervals.every(pair => Math.abs(pair[0]) < 1000)) assert.deepEqual(mergeIntervalsOracle(item.intervals), pairwiseMerge(item.intervals));
});

// ---- Verifier ----------------------------------------------------------------

const ivVerdict = (passed: boolean, visible: boolean, hidden: boolean, source: string) => ({passed, cases: 40, visible_tests_passed: visible, hidden_cases_passed: hidden, candidate_sha256: sha256(source)});
const ivFixture = (options: {mutate?: boolean; hiddenOverride?: (stdout: string) => string} = {}) => verifierFixture({...options, spec: ivSpec});
const ivVerify = (source: string, fixture: ReturnType<typeof verifierFixture>, signal?: AbortSignal) => verifySoftwareCandidate(source, image, fixture.deps, signal, ivSpec);

test("software-intervals: verifier fails the baseline, accepts a correct fix and separates visible from hidden failures", async () => {
  for (const [name, source, expected] of [["baseline", softwareIntervalsBaseline, [false, false, false]], ["fixed", ivFixed, [true, true, true]], ["visible-passing, hidden-failing", ivHiddenOnly, [false, true, false]]] as const) {
    const f = ivFixture(), result = await ivVerify(source, f);
    assert.deepEqual(result, ivVerdict(expected[0], expected[1], expected[2], source), name);
    assert.deepEqual(f.calls, happyCalls, name);
  }
});
test("software-intervals: other plausible wrong or in-place fixes are rejected by the verifier", async () => {
  const wrong: Record<string, string> = {
    // Correct merge but sorts the caller's array in place: the visible no-mutation test and the frozen hidden inputs both catch it.
    "in-place sort": ivFixed.replace("[...intervals].sort(", "(intervals as Array<[number, number]>).sort("),
    // Merges adjacent integers too ([1,2] and [3,4]).
    "adjacent merge": ivFixed.replace("start <= last[1])", "start <= last[1] + 1)"),
    // Forgets the final max for containment.
    "no max": ivFixed.replace("Math.max(last[1], end)", "end"),
    // Mutates the input pair it aliases: frozen hidden inputs throw.
    "alias pair": ivFixed.replace("else merged.push([start, end]);", "else merged.push(pair);").replace("for (const [start, end] of sorted) {", "for (const pair of sorted) { const [start, end] = pair;"),
    // Returns the right answer sorted by end instead of start.
    "wrong order": ivFixed.replace("return merged;", "return merged.reverse();"),
  };
  for (const [name, source] of Object.entries(wrong)) {
    assert.notEqual(source, ivFixed, name);
    const f = ivFixture(), result = await ivVerify(source, f);
    assert.equal(result.passed, false, name); assert.equal(result.hidden_cases_passed, false, name);
    assert.deepEqual(f.calls, happyCalls, name);
    assert.equal(result.visible_tests_passed, false, name);
  }
});
test("software-intervals: verifier container is offline, read-only and unprivileged and the driver is the intervals driver", async () => {
  const f = ivFixture(); await ivVerify(ivFixed, f);
  const args = f.state.created, after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--network"), "none"); assert.ok(args.includes("--read-only")); assert.equal(after("--user"), "65532:65532"); assert.equal(after("--cap-drop"), "ALL");
  assert.equal(after("--security-opt"), "no-new-privileges"); assert.equal(after("--memory"), "256m"); assert.equal(after("--cpus"), "1"); assert.ok(after("--mount").endsWith("dst=/task,readonly,volume-nocopy"));
  const commands: string[][] = [];
  const g = ivFixture(), command = g.deps.command; g.deps.command = async (a, o) => { commands.push(a); return command(a, o); };
  await ivVerify(ivFixed, g);
  assert.deepEqual(commands[0], ["exec", commands[0][1], "node", "--experimental-strip-types", "--test", "--test-reporter=tap", "tests/intervals.test.ts"]);
  assert.equal(commands[1].at(-1), softwareIntervalsHiddenDriver); assert.ok(commands[1].at(-1)!.includes("/task/src/intervals.ts") && !commands[1].at(-1)!.includes("search.ts"));
});
test("software-intervals: hidden cases travel on stdin with a per-run nonce and never carry expected answers", async () => {
  const seen = [];
  for (let run = 0; run < 2; run++) {
    const f = ivFixture(); await ivVerify(ivFixed, f);
    const input = JSON.parse(f.state.stdin); seen.push(input);
    assert.deepEqual(Object.keys(input).sort(), ["cases", "nonce"]); assert.match(input.nonce, /^[0-9a-f]{32}$/); assert.equal(input.cases.length, 40);
    for (const item of input.cases) assert.deepEqual(Object.keys(item), ["intervals"]);
  }
  assert.notEqual(seen[0].nonce, seen[1].nonce);
});
test("software-intervals: a candidate cannot forge the result", async () => {
  const sources = {
    exit: "process['exit'](0);\n" + ivFixed,
    forged: "console.log('# tests 7\\n# pass 7\\n# fail 0');\nconsole.log('CGR 00000000000000000000000000000000 []');\n" + softwareIntervalsBaseline,
    exitHandler: "process.on('exit', () => { process.stdout.write('# tests 7\\n# pass 7\\n# fail 0\\nCGR deadbeef []\\n'); });\n" + softwareIntervalsBaseline,
    stdoutPatch: "process.stdout.write = () => true;\nJSON.stringify = () => '[]';\n" + softwareIntervalsBaseline,
    syntax: "export function (",
    noExport: "export const other = 1;\n",
    // Return values that look like an answer but are not arrays of numeric pairs.
    notAnArray: ivFixed.replace("return merged;", "return {length: 0} as never;"),
    stringPairs: ivFixed.replace("return merged;", "return merged.map(([a, b]) => [String(a), String(b)]) as never;"),
    triples: ivFixed.replace("return merged;", "return merged.map(([a, b]) => [a, b, 0]) as never;"),
    nulls: ivFixed.replace("return merged;", "return merged.map(() => null) as never;"),
    extraPair: ivFixed.replace("return merged;", "return [...merged, [0, 0]];"),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.notEqual(source, ivFixed, name);
    const f = ivFixture(), result = await ivVerify(source, f);
    assert.equal(result.passed, false, name); assert.equal(result.hidden_cases_passed, false, name);
    assert.deepEqual(f.calls, happyCalls, name);
  }
  const noisy = ivFixture(), accepted = await ivVerify("console.log('noise');\nconsole.error('noise');\n" + ivFixed, noisy);
  assert.equal(accepted.hidden_cases_passed, true);
  const loud = ivFixture(), rejected = await ivVerify("for (let i = 0; i < 1000; i++) console.log('noise');\n" + softwareIntervalsBaseline, loud);
  assert.equal(rejected.hidden_cases_passed, false);
});
test("software-intervals: toJSON, getter and proxy results are copied into plain arrays before the result line", async () => {
  // A correct merge that wraps its answer in exotic objects is accepted: only plain copies of the numbers reach the result line.
  const exotic = {
    toJSON: ivFixed.replace("return merged;", "return Object.assign(merged.map(pair => Object.assign(pair, {toJSON: () => 'x'})), {toJSON: () => 'x'});"),
    proxy: ivFixed.replace("return merged;", "return new Proxy(merged.map(pair => new Proxy(pair, {})), {});"),
    getters: ivFixed.replace("return merged;", "return merged.map(([a, b]) => ({get 0() { return a; }, get 1() { return b; }, length: 2}) as never);"),
  };
  const f = ivFixture(), good = await ivVerify(exotic.toJSON, f); assert.equal(good.hidden_cases_passed, true);
  const g = ivFixture(), proxied = await ivVerify(exotic.proxy, g); assert.equal(proxied.hidden_cases_passed, true);
  // Array-likes that are not arrays are rejected even though their values read correctly.
  const h = ivFixture(), arrayLike = await ivVerify(exotic.getters, h); assert.equal(arrayLike.hidden_cases_passed, false);
  // Each answer may hold at most as many pairs as the input, so an inflated length cannot stall the driver.
  const huge = ivFixture(), inflated = await ivVerify(ivFixed.replace("return merged;", "return new Proxy(merged, {get: (target, key) => key === 'length' ? 1e9 : (target as never)[key]});"), huge);
  assert.equal(inflated.hidden_cases_passed, false);
});

for (const spec of [softwareBoundsSpec, ivSpec]) {
  test(`${spec.id}: inherited serialization hooks cannot change hidden numeric results`, async () => {
    const reference = spec === ivSpec ? ivFixed : fixed;
    for (const prototype of ["Array.prototype", "Object.prototype"]) {
      // Also replace the public setter: the driver must use the reference
      // captured before candidate import for every result, answer and pair.
      const hook = `${prototype}.toJSON = () => 'spoofed';\nObject.setPrototypeOf = value => value;\n`;
      for (const [source, expected] of [[reference, true], [spec.baseline, false]] as const) {
        let output = "";
        const f = verifierFixture({spec, hiddenOverride: stdout => { output = stdout; return stdout; }});
        const result = await verifySoftwareCandidate(hook + source, image, f.deps, undefined, spec);
        assert.equal(result.hidden_cases_passed, expected, `${prototype}/${expected}`);
        const input = JSON.parse(f.state.stdin);
        assert.ok(output.startsWith(`CGR ${input.nonce} [`), "the trusted result remains an array");
        if (expected) assert.deepEqual(JSON.parse(output.slice(`CGR ${input.nonce} `.length)), input.cases.map((item: unknown) => spec.hidden.oracle(item)));
        assert.deepEqual(f.calls, happyCalls);
      }
    }
  });
}
test("software-intervals: a result line of a different run or a duplicated line is not accepted", async () => {
  for (const hiddenOverride of [(stdout: string) => stdout.replace(/CGR [0-9a-f]{32}/, "CGR " + "0".repeat(32)), (stdout: string) => stdout + stdout]) {
    const f = ivFixture({hiddenOverride}), result = await ivVerify(ivFixed, f);
    assert.equal(result.hidden_cases_passed, false); assert.equal(result.visible_tests_passed, true);
  }
});
test("software-intervals: timeouts and output floods fail the check, but cancellation and other Docker errors propagate", async () => {
  for (const [reason, step, expected, tail] of [["timeout", "visible", ivVerdict(false, false, false, ivFixed), ["visible", "container", "close"]], ["output_limit", "visible", ivVerdict(false, false, true, ivFixed), ["visible", "hidden", "exec", "container", "close"]],
    ["timeout", "hidden", ivVerdict(false, true, false, ivFixed), ["visible", "hidden", "container", "close"]], ["output_limit", "hidden", ivVerdict(false, true, false, ivFixed), ["visible", "hidden", "exec", "container", "close"]]] as const) {
    const f = ivFixture(), command = f.deps.command;
    f.deps.command = async (args, options) => { if (args.includes("--test-reporter=tap") === (step === "visible")) { f.calls.push(step); throw new DockerCommandError(reason); } return command(args, options); };
    const result = await ivVerify(ivFixed, f);
    assert.deepEqual(result, expected, `${reason} during ${step}`); assert.deepEqual(f.calls.slice(f.calls.indexOf("start") + 1), tail, `${reason} during ${step}`);
  }
  const seenOptions: Array<{maxBytes?: number}> = [];
  const probe = ivFixture(), command = probe.deps.command; probe.deps.command = async (args, options) => { seenOptions.push(options); return command(args, options); };
  await ivVerify(ivFixed, probe); assert.equal(seenOptions[1].maxBytes, 32_768);
  const failing = ivFixture(); failing.deps.command = async () => { throw new DockerCommandError("failed"); };
  await assert.rejects(ivVerify(ivFixed, failing), error => error instanceof DockerCommandError); assert.equal(failing.calls.at(-1), "close");
  const controller = new AbortController(), cancelled = ivFixture();
  cancelled.deps.command = async () => { controller.abort("cancelled"); throw new DockerCommandError("timeout"); };
  await assert.rejects(ivVerify(ivFixed, cancelled, controller.signal)); assert.equal(cancelled.calls.at(-1), "close");
});
test("software-intervals: a mutated candidate is detected, unsafe candidates never reach Docker and cleanup failures keep their category", async () => {
  const mutated = ivFixture({mutate: true});
  await assert.rejects(ivVerify(ivFixed, mutated), /verifier_candidate_mutated/); assert.deepEqual(mutated.calls.slice(-3), ["exec", "container", "close"]);
  const f = ivFixture();
  for (const source of ["// Bearer synthetic-canary-token-value\n", "a\0b", " ".repeat(16385), "\ud800", ivFixed + "// child_process\n", ivFixed + "// process.exit\n"]) await assert.rejects(ivVerify(source, f), /candidate_/);
  const controller = new AbortController(); controller.abort("cancelled");
  await assert.rejects(ivVerify(ivFixed, f, controller.signal)); assert.deepEqual(f.calls, []);
  for (const fault of ["container", "staging"] as const) {
    const g = ivFixture(); g.state.fail = fault;
    await assert.rejects(ivVerify(ivFixed, g), error => { assert.ok(error instanceof ControlledTaskCleanupError); assert.equal(error.scope, "verifier"); assert.equal(error.errors.length, 1); return true; });
    assert.equal(g.calls.at(-1), "close");
  }
});

// ---- Host Node checks of the pinned bundle itself -----------------------------

test("software-intervals: with the host's Node the visible tests fail on the baseline, pass on the fix and on the hidden-only variant", async () => {
  assert.ok(ivSpec.visibleTestCount >= 6);
  const root = await mkdtemp(path.join(tmpdir(), "cg-software-host-"));
  try {
    for (const [source, code] of [[softwareIntervalsBaseline, 1], [ivFixed, 0], [ivHiddenOnly, 0]] as const) {
      await rm(path.join(root, "t"), {recursive: true, force: true}); await ivSeedBundle(path.join(root, "t"), source);
      const result = await new Promise<{code: number; stdout: string}>(resolve => execFile(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", "tests/intervals.test.ts"], {cwd: path.join(root, "t"), env: cleanEnv}, (error, stdout) => resolve({code: error ? Number((error as {code: unknown}).code) : 0, stdout})));
      assert.equal(result.code, code); assert.match(result.stdout, new RegExp(`^# tests ${ivSpec.visibleTestCount}$`, "m"));
      if (code === 0) assert.match(result.stdout, /^# fail 0$/m); else assert.doesNotMatch(result.stdout, /^# fail 0$/m);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
test("software-intervals: the reference fix agrees with the host oracle on every hidden case, the hidden-only variant does not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cg-software-oracle-"));
  try {
    const load = async (name: string, source: string) => { await writeFile(path.join(root, name), source); return (await import(new URL("file:///" + path.join(root, name).replaceAll("\\", "/")).href)).mergeIntervals as (value: unknown) => unknown; };
    const fixedModule = await load("fixed.ts", ivFixed), hiddenOnlyModule = await load("hidden-only.ts", ivHiddenOnly);
    const all = [...softwareIntervalsHiddenCases(), ...softwareIntervalsHiddenCases(new Uint8Array(500).map((_, index) => (index * 37 + 11) % 256))];
    let disagreements = 0;
    for (const item of all) {
      const expected = mergeIntervalsOracle(item.intervals);
      assert.deepEqual(fixedModule(structuredClone(item.intervals)), expected);
      try { assert.deepEqual(hiddenOnlyModule(structuredClone(item.intervals)), expected); } catch { disagreements++; }
    }
    assert.ok(disagreements >= 3, `the hidden-only variant must fail several hidden cases (failed ${disagreements})`);
  } finally { await rm(root, {recursive: true, force: true}); }
});
