import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { contractHash } from "@commongrid/task-schema";
import { ControlledTaskCleanupError, applyControlledPatch, buildControlledPatch, controlledBaseline, controlledTaskExecDescription, createControlledPatch, type ControlledVerifierDeps } from "../src/controlled-task.ts";
import { taskCandidateSnapshotScript } from "../src/controlled-task-artifact.ts";
import { gitFixtureEpoch, gitFixtureIdentity, gitFixtureIds, gitFixtureMessage } from "../src/git-object-ids.mjs";
import { SoftwareBundleError, assertSoftwareCandidate, lowerBoundOracle, seedSoftwareTask, snapshotSoftwareCandidate, softwareBaseline, softwareBoundsTask, softwareBoundsTaskId, softwareEntryFiles,
  findSoftwareStrategy, softwareForbiddenPatterns, softwareHarnessInstructions, softwareStrategyNotice, softwareHiddenCases, softwareSnapshotScript, softwareSnapshotSpec, softwareTaskPrompt, softwareTestArgv, softwareVerifierCases,
  softwareVisibleTestCount, verifyCatalogSoftwareBundle, verifySoftwareBundle, verifySoftwareCandidate, type SoftwareBundlePin } from "../src/software-task.ts";
import { softwareBoundsBundle } from "../src/software-bounds-bundle.generated.ts";
import { DockerCommandError } from "../src/task-runtime.ts";
import { taskRunCatalogPins, taskRunStrategyIds, validTaskRunPatch } from "../src/task-run-protocol.ts";

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

test("bundle ids match the generated file, the catalog commit and real git objects", t => {
  const files = softwareBoundsBundle.files.map(file => ({path: file.path, content: file.content}));
  const ids = gitFixtureIds(files);
  assert.equal(ids.commit, softwareBoundsBundle.git.commit); assert.equal(ids.tree, softwareBoundsBundle.git.tree); assert.deepEqual(ids.blobs, softwareBoundsBundle.git.blobs);
  assert.equal(catalogTask.workspace.commit, ids.commit);
  for (const file of softwareBoundsBundle.files) assert.equal(file.sha256, sha256(file.content));
  assert.ok(files.every(file => !file.content.includes("\r")) && files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= 12_288);
  try { execFileSync("git", ["--version"], {stdio: "ignore"}); } catch { t.skip("git unavailable"); return; }
  const directory = path.join(tmpdir(), `cg-software-git-${process.pid}-${Date.now()}`);
  execFileSync("git", ["init", "-q", directory]);
  try {
    const git = (args: string[], input?: string, env: NodeJS.ProcessEnv = {}) => execFileSync("git", ["-C", directory, "-c", "commit.gpgsign=false", ...args], {input, env: {...process.env, ...env}, encoding: "utf8"}).trim();
    const blob = (name: string) => git(["hash-object", "-w", "--no-filters", "--stdin"], files.find(file => file.path === name)!.content);
    const src = git(["mktree"], `100644 blob ${blob("src/search.ts")}\tsearch.ts\n`), tests = git(["mktree"], `100644 blob ${blob("tests/search.test.ts")}\tsearch.test.ts\n`);
    const root = git(["mktree"], `100644 blob ${blob("package.json")}\tpackage.json\n040000 tree ${src}\tsrc\n040000 tree ${tests}\ttests\n`);
    const [name, email] = [gitFixtureIdentity.split(" <")[0], gitFixtureIdentity.split(" <")[1].slice(0, -1)], date = `${gitFixtureEpoch} +0000`;
    const commit = git(["commit-tree", root, "-m", gitFixtureMessage], undefined, {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date});
    assert.deepEqual({commit, tree: root, src, tests}, {commit: ids.commit, tree: ids.tree, src: (ids.trees as Record<string, string>).src, tests: (ids.trees as Record<string, string>).tests});
  } finally { execFileSync(process.execPath, ["-e", "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", directory]); }
});
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
function verifierFixture(options: {mutate?: boolean; hiddenOverride?: (stdout: string) => string} = {}) {
  const calls: string[] = [], state = {dir: "", created: [] as string[], stdin: "", fail: undefined as undefined | "container" | "staging"};
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
        if (options.mutate) out["src/search.ts"] = "0".repeat(64);
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
      const driver = args.at(-1)!.replace("'/task/src/search.ts'", JSON.stringify(new URL("file:///" + path.join(state.dir, "src/search.ts").replaceAll("\\", "/")).href));
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
