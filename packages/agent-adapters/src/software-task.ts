// Catalog software tasks (`software-bounds`: lowerBound, `software-intervals`:
// mergeIntervals) run through the same native approved-run flow as the
// controlled sum.mjs task. The task files come from a pinned local bundle
// (task-assets/<task id>) whose synthetic git commit is the catalog contract's
// workspace.commit: nothing is cloned or downloaded. The agent sees only the
// bundle's package.json, one source file and its visible tests, and may change
// the source file alone. Hidden cases and their expected answers stay on the
// host; the verifier container is offline, read-only and throwaway. A task is
// described by one plain SoftwareTaskSpec record; software-bounds is the default.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { validateTask, type TaskContract } from "@commongrid/task-schema";
import catalog from "../../task-schema/fixtures/catalog.json";
import { gitFixtureIds } from "./git-object-ids.mjs";
import { softwareBoundsBundle } from "./software-bounds-bundle.generated.ts";
import { softwareIntervalsBundle } from "./software-intervals-bundle.generated.ts";
import { DockerCommandError } from "./task-runtime.ts";
import { ControlledTaskCleanupError, controlledOwnerLabel, controlledTaskExecDescription, controlledVerifierDeps, snapshotControlledCandidate, type ControlledTaskDocker, type ControlledVerifierDeps } from "./controlled-task.ts";
import { taskCandidateSnapshotScript, validateControlledCandidateSource, type TaskSnapshotSpec } from "./controlled-task-artifact.ts";
import { canonicalPinnedImageReference } from "./pinned-image.ts";
import { taskRunCatalogPins, taskRunStrategyIds } from "./task-run-protocol.ts";
import type { TaskToolsRuntime } from "./task-runtime.ts";

export const softwareBoundsTaskId = "software-bounds";
export const softwareIntervalsTaskId = "software-intervals";
export type SoftwareTaskId = typeof softwareBoundsTaskId | typeof softwareIntervalsTaskId;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const catalogEntry = (id: string): unknown => (catalog as {tasks: Array<{id: string}>}).tasks.find(task => task.id === id);
const countVisibleTests = (source: string) => (source.match(/^test\(/gm) ?? []).length;

// ---- Per-task spec ----------------------------------------------------------

export interface SoftwareBundle {
  readonly files: ReadonlyArray<{readonly path: string; readonly content: string; readonly sha256: string}>;
  readonly git: {readonly commit: string; readonly tree: string};
}
/** Host-side hidden check: cases generated after the export, expected answers from the oracle, a driver that runs in the verifier container. */
export interface SoftwareHiddenSpec {
  cases(random?: Uint8Array): unknown[];
  oracle(item: any): unknown;
  /** Source of the in-container driver (stdin: nonce and cases; prints one nonce-bearing result line). */
  driver: string;
  /** Output cap of the hidden exec. */
  maxBytes: number;
}
export interface SoftwareTaskSpec {
  id: SoftwareTaskId;
  bundle: SoftwareBundle;
  /** Exact bundle file list, in bundle order: the pinned inventory the contract is bound to. */
  bundlePaths: readonly string[];
  /** The one file the agent may change. */
  writablePath: string;
  visibleTestPath: string;
  entryFiles: readonly string[];
  /** What the agent is told to run; the verifier adds a TAP reporter so it can read the test count. */
  testArgv: readonly string[];
  testCommand: string;
  /** Substrings matched on the candidate source (catalog verification.forbidden_patterns). */
  forbiddenPatterns: readonly string[];
  /** Bounded by the Windows command line: the candidate travels as one docker exec argument. */
  candidateJsonLimit: number;
  verifierCases: number;
  limits: Readonly<{cpu: number; memory_mb: number; time_limit_sec: number}>;
  hidden: SoftwareHiddenSpec;
  /** The pristine, deliberately buggy baseline of the writable file. */
  baseline: string;
  visibleTestCount: number;
  snapshotSpec: TaskSnapshotSpec;
  snapshotScript: string;
  harnessInstructions: string;
  /** The unvalidated catalog entry; verifySoftwareBundle binds it to the pinned bundle and contract hash. */
  catalogTask: unknown;
}
const harnessFor = (writablePath: string, visibleTestPath: string, testArgv: readonly string[]) =>
  `Workspace: the working directory is /task. Edit only /task/${writablePath}, using only task_exec. The visible tests in /task/${visibleTestPath} and /task/package.json must not be edited, and no other file may be created. Run the visible tests with argv ` +
  JSON.stringify(testArgv) + " (Node strips types, so use erasable TypeScript syntax only). Additional independent checks run elsewhere. Report a short completion.";
function bundleFileOf(bundle: SoftwareBundle, path: string) {
  const file = bundle.files.find(item => item.path === path);
  if (!file) throw new Error("software_bundle_file_missing");
  return file;
}
interface SoftwareTaskSpecInput { id: SoftwareTaskId; bundle: SoftwareBundle; writablePath: string; visibleTestPath: string; hidden: SoftwareHiddenSpec }
function makeSpec(input: SoftwareTaskSpecInput): SoftwareTaskSpec {
  const {id, bundle, writablePath, visibleTestPath, hidden} = input;
  const testArgv = Object.freeze(["node", "--experimental-strip-types", "--test", visibleTestPath]);
  const snapshotSpec: TaskSnapshotSpec = Object.freeze({
    files: Object.freeze(bundle.files.map(file => Object.freeze({path: file.path, sha256: file.path === writablePath ? null : file.sha256}))),
  });
  return Object.freeze({
    id, bundle, writablePath, visibleTestPath, hidden: Object.freeze(hidden),
    bundlePaths: Object.freeze(bundle.files.map(file => file.path)),
    entryFiles: Object.freeze([writablePath, visibleTestPath]),
    testArgv, testCommand: testArgv.join(" "),
    forbiddenPatterns: Object.freeze(["child_process", "node:fs", "process.exit"]),
    candidateJsonLimit: 12_000,
    verifierCases: 40,
    limits: Object.freeze({cpu: 1, memory_mb: 256, time_limit_sec: 1200}),
    baseline: bundleFileOf(bundle, writablePath).content,
    visibleTestCount: countVisibleTests(bundleFileOf(bundle, visibleTestPath).content),
    snapshotSpec, snapshotScript: taskCandidateSnapshotScript(snapshotSpec),
    harnessInstructions: harnessFor(writablePath, visibleTestPath, testArgv),
    catalogTask: catalogEntry(id),
  });
}

// ---- software-bounds: hidden cases and driver -------------------------------

/** Host oracle: first index with values[i] >= target, else values.length. */
export function lowerBoundOracle(values: readonly number[], target: number): number {
  for (let index = 0; index < values.length; index++) if (values[index] >= target) return index;
  return values.length;
}
export interface SoftwareHiddenCase { values: number[]; target: number }
const boundsVerifierCases = 40;
const fixedCases: ReadonlyArray<readonly [number[], number]> = [
  [[], 0], [[], -5], [[5], 4], [[5], 5], [[5], 6], [[2, 2, 2, 2], 1], [[2, 2, 2, 2], 2], [[2, 2, 2, 2], 3],
  [[1, 3, 5, 7, 9], 0], [[1, 3, 5, 7, 9], 10], [[1, 3, 5, 7, 9], 9], [[1, 3, 5, 7, 9], 1], [[1, 3, 5, 7, 9], 4],
  [[-9, -4, -4, -1, 0, 0, 3], -4], [[-9, -4, -4, -1, 0, 0, 3], -5], [[-9, -4, -4, -1, 0, 0, 3], 0],
  [[1, 2, 2, 2, 2, 3], 2], [[1, 2], 3],
  [[Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER], [[Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER], Number.MIN_SAFE_INTEGER],
];
const randomCases = boundsVerifierCases - fixedCases.length;
/** Fixed edge cases plus random sorted arrays (duplicates likely); generate after the candidate was exported. */
export function softwareHiddenCases(random: Uint8Array = randomBytes(2048)): SoftwareHiddenCase[] {
  const cases = fixedCases.map(([values, target]) => ({values: [...values], target}));
  let at = 0;
  const next = () => random[at++ % random.length];
  for (let index = 0; index < randomCases; index++) {
    const length = next() % 65;
    cases.push({values: Array.from({length}, () => (next() % 41) - 20).sort((a, b) => a - b), target: (next() % 49) - 24});
  }
  return cases;
}
// Runs inside the verifier container. The cases and the result nonce arrive on
// stdin before the candidate is imported; the real stdout writer and JSON are
// captured first and the candidate's own output is discarded, so only this
// script can print the nonce-bearing result line. Inputs are frozen.
export const softwareHiddenDriver = "const write=process.stdout.write.bind(process.stdout),stringify=JSON.stringify,parse=JSON.parse,exit=process.exit.bind(process),concat=Buffer.concat;" +
  "const chunks=[];for await(const chunk of process.stdin)chunks[chunks.length]=chunk;" +
  "const {nonce,cases}=parse(concat(chunks).toString('utf8'));" +
  "process.stdout.write=()=>true;process.stderr.write=()=>true;" +
  "for(const item of cases)Object.freeze(item.values);" +
  "const {lowerBound}=await import('/task/src/search.ts');" +
  "const results=[];let at=0;" +
  "for(const item of cases){let value=null;try{const found=lowerBound(item.values,item.target);if(typeof found==='number')value=found}catch{}results[at++]=value}" +
  "write('CGR '+nonce+' '+stringify(results)+'\\n',()=>exit(0));";

export const softwareBoundsSpec: SoftwareTaskSpec = makeSpec({
  id: softwareBoundsTaskId, bundle: softwareBoundsBundle, writablePath: "src/search.ts", visibleTestPath: "tests/search.test.ts",
  hidden: {cases: softwareHiddenCases, oracle: (item: SoftwareHiddenCase) => lowerBoundOracle(item.values, item.target), driver: softwareHiddenDriver, maxBytes: 16_384},
});

// ---- software-intervals: hidden cases and driver -----------------------------

export type SoftwareInterval = [number, number];
/** Host oracle: closed intervals that overlap or touch merge; a new array sorted by start. The input is not modified. */
export function mergeIntervalsOracle(intervals: ReadonlyArray<readonly [number, number]>): SoftwareInterval[] {
  const sorted = intervals.map(([start, end]): SoftwareInterval => [start, end]);
  sorted.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const merged: SoftwareInterval[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last === undefined || start > last[1]) merged.push([start, end]);
    else if (end > last[1]) last[1] = end;
  }
  return merged;
}
export interface SoftwareIntervalsCase { intervals: SoftwareInterval[] }
const maxSafe = Number.MAX_SAFE_INTEGER, minSafe = Number.MIN_SAFE_INTEGER;
const fixedIntervalCases: ReadonlyArray<ReadonlyArray<SoftwareInterval>> = [
  [], [[5, 5]], [[0, 0], [0, 0]], [[1, 3], [3, 5]], [[3, 5], [1, 3]], [[1, 2], [3, 4]], [[1, 2], [4, 5]],
  [[1, 10], [2, 3], [4, 5]], [[1, 4], [0, 4]], [[1, 3], [1, 2]], [[1, 2], [1, 5], [1, 3]], [[2, 3], [2, 3], [2, 3]],
  [[3, 4], [1, 2], [2, 3]], [[1, 5], [2, 3], [6, 8], [7, 7], [9, 10]],
  [[10, 12], [9, 11]], [[100, 200], [20, 30], [25, 99], [101, 120]], [[-1, 2], [-10, -3]], [[-5, -1], [-10, -6]], [[-10, -2], [-3, 4], [4, 4], [6, 6]],
  [[minSafe, 0], [0, maxSafe]], [[maxSafe, maxSafe], [minSafe, minSafe], [minSafe, minSafe + 1], [maxSafe - 1, maxSafe]],
];
const intervalsVerifierCases = 40;
const randomIntervalCases = intervalsVerifierCases - fixedIntervalCases.length;
/** Fixed edge cases plus small random interval lists (negatives, multi-digit starts, duplicates, touching ends likely). */
export function softwareIntervalsHiddenCases(random: Uint8Array = randomBytes(2048)): SoftwareIntervalsCase[] {
  const cases = fixedIntervalCases.map(intervals => ({intervals: intervals.map(([start, end]): SoftwareInterval => [start, end])}));
  let at = 0;
  const next = () => random[at++ % random.length];
  for (let index = 0; index < randomIntervalCases; index++) {
    const length = next() % 17, intervals: SoftwareInterval[] = [];
    for (let item = 0; item < length; item++) { const start = (next() % 81) - 40; intervals.push([start, start + (next() % 13)]); }
    cases.push({intervals});
  }
  return cases;
}
// Same stdin, nonce and stdout hardening as the bounds driver. Inputs (the list
// and every pair) are deep-frozen, so a candidate that sorts or edits them in
// place throws. The answer is accepted only if it is an array of 2-element
// arrays of numbers that is no longer than the input; it is copied into plain
// arrays before stringify, so toJSON, getters and proxies cannot reach the result line.
export const softwareIntervalsHiddenDriver = "const write=process.stdout.write.bind(process.stdout),stringify=JSON.stringify,parse=JSON.parse,exit=process.exit.bind(process),concat=Buffer.concat,isArray=Array.isArray,freeze=Object.freeze;" +
  "const chunks=[];for await(const chunk of process.stdin)chunks[chunks.length]=chunk;" +
  "const {nonce,cases}=parse(concat(chunks).toString('utf8'));" +
  "process.stdout.write=()=>true;process.stderr.write=()=>true;" +
  "for(const item of cases){for(const pair of item.intervals)freeze(pair);freeze(item.intervals)}" +
  "const {mergeIntervals}=await import('/task/src/intervals.ts');" +
  "const results=[];let at=0;" +
  "for(const item of cases){let value=null;try{const found=mergeIntervals(item.intervals);" +
  "if(isArray(found)){const size=found.length,copy=[];let valid=size<=item.intervals.length;" +
  "for(let index=0;valid&&index<size;index++){const pair=found[index];if(isArray(pair)&&pair.length===2){const start=pair[0],end=pair[1];if(typeof start==='number'&&typeof end==='number')copy[index]=[start,end];else valid=false}else valid=false}" +
  "if(valid)value=copy}}catch{}results[at++]=value}" +
  "write('CGR '+nonce+' '+stringify(results)+'\\n',()=>exit(0));";

export const softwareIntervalsSpec: SoftwareTaskSpec = makeSpec({
  id: softwareIntervalsTaskId, bundle: softwareIntervalsBundle, writablePath: "src/intervals.ts", visibleTestPath: "tests/intervals.test.ts",
  hidden: {cases: softwareIntervalsHiddenCases, oracle: (item: SoftwareIntervalsCase) => mergeIntervalsOracle(item.intervals), driver: softwareIntervalsHiddenDriver, maxBytes: 32_768},
});

/** Catalog software tasks the native runner implements, keyed by task id. */
export const softwareTaskSpecs: Readonly<Record<SoftwareTaskId, SoftwareTaskSpec>> = Object.freeze({
  [softwareBoundsTaskId]: softwareBoundsSpec,
  [softwareIntervalsTaskId]: softwareIntervalsSpec,
});
/** The spec of a task id, or undefined when the id is not a catalog software task (e.g. the controlled task). */
export function softwareTaskSpecFor(taskId: string): SoftwareTaskSpec | undefined {
  return Object.hasOwn(softwareTaskSpecs, taskId) ? softwareTaskSpecs[taskId as SoftwareTaskId] : undefined;
}

// Bounds aliases kept for existing callers.
export const softwareWritablePath = softwareBoundsSpec.writablePath;
export const softwareEntryFiles: readonly string[] = softwareBoundsSpec.entryFiles;
export const softwareForbiddenPatterns: readonly string[] = softwareBoundsSpec.forbiddenPatterns;
export const softwareTestArgv: readonly string[] = softwareBoundsSpec.testArgv;
export const softwareTestCommand = softwareBoundsSpec.testCommand;
export const softwareCandidateJsonLimit = softwareBoundsSpec.candidateJsonLimit;
export const softwareVerifierCases = softwareBoundsSpec.verifierCases;
/** The pristine, deliberately buggy baseline of the one writable file. */
export const softwareBaseline: string = softwareBoundsSpec.baseline;
export const softwareIntervalsBaseline: string = softwareIntervalsSpec.baseline;
export const softwareVisibleTestCount = softwareBoundsSpec.visibleTestCount;
/** The unvalidated catalog entries; verifySoftwareBundle binds each to its pinned bundle and contract hash. */
export const softwareBoundsTask: unknown = softwareBoundsSpec.catalogTask;
export const softwareIntervalsTask: unknown = softwareIntervalsSpec.catalogTask;

// ---- Contract binding ------------------------------------------------------

/** A bundle/contract mismatch. The native worker reports it as asset_invalid; `reason` is for tests only. */
export class SoftwareBundleError extends Error {
  readonly code = "asset_invalid";
  constructor(readonly reason: string) { super("software_bundle_invalid"); }
}
export interface SoftwareBundlePin { task_version: number; contract_hash: string; /** Image the native runtime actually uses. */ image: string }
const equalLists = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Proves, before any Docker call, that the catalog contract is the exact one
 * the runner implements: pinned id/version/hash, the bundle's recomputed git
 * commit, paths, approved strategy ids, forbidden patterns, image and limits.
 * `bundle` defaults to the spec's own pinned bundle (tests pass a tampered one).
 */
export async function verifySoftwareBundle(value: unknown, pin: SoftwareBundlePin | undefined, bundle?: SoftwareBundle, spec: SoftwareTaskSpec = softwareBoundsSpec): Promise<TaskContract> {
  const fail = (reason: string): never => { throw new SoftwareBundleError(reason); };
  const {files, git} = bundle ?? spec.bundle;
  if (!pin || !Number.isSafeInteger(pin.task_version) || typeof pin.contract_hash !== "string" || typeof pin.image !== "string") fail("pin");
  let task: TaskContract;
  try { task = await validateTask(value); } catch { return fail("contract"); }
  if (task.id !== spec.id || task.type !== "software" || task.kind !== "solve") fail("identity");
  if (task.task_version !== pin!.task_version || task.contract_hash !== pin!.contract_hash) fail("pin");
  for (const file of files) if (sha256(file.content) !== file.sha256) fail("bundle_file");
  const ids = gitFixtureIds(files);
  if (ids.commit !== git.commit || ids.tree !== git.tree || ids.commit !== task.workspace.commit) fail("commit");
  const paths: string[] = files.map(file => file.path);
  if (!equalLists(paths, spec.bundlePaths) || !spec.entryFiles.every(path => paths.includes(path))) fail("bundle_files");
  if (!equalLists(task.workspace.entry_files, spec.entryFiles) || !equalLists(task.workspace.writable_paths, [spec.writablePath])) fail("paths");
  // The ids the protocol lets the UI name must be exactly the contract's, in order; instructions stay in the hash-verified contract.
  if (!equalLists(task.strategies.map(item => item.id), taskRunStrategyIds[spec.id])) fail("strategies");
  if (!equalLists(task.verification.forbidden_patterns, spec.forbiddenPatterns)) fail("forbidden_patterns");
  if (task.verification.local_precheck !== spec.testCommand || task.verification.server_command !== spec.testCommand) fail("command");
  let image: string, pinned: string;
  try { image = canonicalPinnedImageReference(task.environment.image); pinned = canonicalPinnedImageReference(pin!.image); } catch { return fail("image"); }
  if (image !== pinned) fail("image");
  if (task.environment.cpu !== spec.limits.cpu || task.environment.memory_mb !== spec.limits.memory_mb || task.environment.time_limit_sec !== spec.limits.time_limit_sec) fail("limits");
  return task;
}
/** Verifies the shipped catalog entry against the runner's pin (taskRunCatalogPins[spec.id]) for the image in use. */
export function verifyCatalogSoftwareBundle(image: string, spec: SoftwareTaskSpec = softwareBoundsSpec): Promise<TaskContract> {
  const pin = taskRunCatalogPins[spec.id];
  return verifySoftwareBundle(spec.catalogTask, pin && {...pin, image}, undefined, spec);
}

export const softwareHarnessInstructions = softwareBoundsSpec.harnessInstructions;
export type SoftwareStrategy = TaskContract["strategies"][number];
/** Fixed wording after a contract strategy; the strategy guides the approach only. */
export const softwareStrategyNotice = "This strategy only guides your approach; it does not change the task or its acceptance criteria.";
/** The contract's own entry for a strategy id, or undefined. Only the id crosses the UI boundary. */
export function findSoftwareStrategy(contract: Pick<TaskContract, "strategies">, strategyId: string | null): SoftwareStrategy | undefined {
  return contract.strategies.find(item => item.id === strategyId);
}
/**
 * The catalog prompt, the approved strategy block taken verbatim from the
 * verified contract, then the task's fixed harness description; neither the
 * contract nor the strategy can change the tool contract.
 */
export function softwareTaskPrompt(contract: Pick<TaskContract, "prompt">, strategy: SoftwareStrategy, spec: SoftwareTaskSpec = softwareBoundsSpec): string {
  return `${contract.prompt}\n\nApproved strategy (${strategy.id}): ${strategy.instructions}\n${softwareStrategyNotice}\n\n${spec.harnessInstructions}\n\nTask tool contract: ${controlledTaskExecDescription}`;
}

// ---- Seeding ---------------------------------------------------------------

type Exec = Pick<TaskToolsRuntime, "exec">;
const writeScript = "const fs=require('node:fs'),path=require('node:path'),[name,text]=JSON.parse(process.argv[1]),target='/task/'+name;fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text,{flag:'wx'});";
/** Writes the pristine bundle (one exec per file); `candidate` replaces only the writable file. */
export async function seedSoftwareTask(runtime: Exec, candidate?: string, spec: SoftwareTaskSpec = softwareBoundsSpec): Promise<void> {
  for (const file of spec.bundle.files) {
    const content = candidate !== undefined && file.path === spec.writablePath ? candidate : file.content;
    const result = await runtime.exec(["node", "-e", writeScript, JSON.stringify([file.path, content])]);
    assert.equal(result.code, 0, "software_task_seed_failed");
  }
}

// ---- Candidate policy and snapshot -----------------------------------------

/** Host-side policy on top of the exporter's content policy. Errors start with `candidate_`. */
export function assertSoftwareCandidate(source: string, spec: SoftwareTaskSpec = softwareBoundsSpec): void {
  validateControlledCandidateSource(source);
  if (Buffer.byteLength(JSON.stringify(source)) > spec.candidateJsonLimit) throw new Error("candidate_limit");
  if (spec.forbiddenPatterns.some(pattern => source.includes(pattern))) throw new Error("candidate_forbidden_pattern");
}
export const softwareSnapshotSpec: TaskSnapshotSpec = softwareBoundsSpec.snapshotSpec;
export const softwareSnapshotScript = softwareBoundsSpec.snapshotScript;
/** Freezes the task, exports the writable file through the read-only exporter and applies the host policy. */
export async function snapshotSoftwareCandidate(runtime: Parameters<typeof snapshotControlledCandidate>[0], image: string, docker?: ControlledTaskDocker, spec: SoftwareTaskSpec = softwareBoundsSpec): Promise<string> {
  const source = await snapshotControlledCandidate(runtime, image, docker, spec.snapshotScript);
  assertSoftwareCandidate(source, spec);
  if (source === spec.baseline) throw new Error("candidate_unchanged");
  return source;
}

// ---- Independent verifier --------------------------------------------------

export const softwareHashScript = "const fs=require('node:fs'),crypto=require('node:crypto'),out={};for(const name of JSON.parse(process.argv[1]))out[name]=crypto.createHash('sha256').update(fs.readFileSync('/task/'+name)).digest('hex');console.log(JSON.stringify(out));";

export interface SoftwareVerifierResult { passed: boolean; cases: number; visible_tests_passed: boolean; hidden_cases_passed: boolean; candidate_sha256: string }
type CommandResult = Awaited<ReturnType<ControlledTaskDocker["command"]>>;
// The last summary lines belong to the test runner itself; candidate output is printed earlier.
function visibleSummary(result: CommandResult, expectedTests: number): boolean {
  if (result.code !== 0) return false;
  const last = (key: string) => {
    const found = [...result.stdout.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
    return found.length ? Number(found[found.length - 1][1]) : -1;
  };
  return last("tests") === expectedTests && last("pass") === expectedTests && last("fail") === 0;
}
function hiddenResult(result: CommandResult, nonce: string, expected: unknown[]): boolean {
  if (result.code !== 0) return false;
  const prefix = `CGR ${nonce} `, lines = result.stdout.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return false;
  try { assert.deepEqual(JSON.parse(lines[0].slice(prefix.length)), expected); return true; } catch { return false; }
}

/** Verifies a candidate against the pristine visible tests and host-generated hidden cases in a throwaway offline container. */
export async function verifySoftwareCandidate(source: string, image: string, deps: ControlledVerifierDeps = controlledVerifierDeps, signal?: AbortSignal, spec: SoftwareTaskSpec = softwareBoundsSpec): Promise<SoftwareVerifierResult> {
  assertSoftwareCandidate(source, spec);
  signal?.throwIfAborted();
  const staging = await deps.staging(image).catch(error => {
    if (error instanceof AggregateError && error.message === "sandbox_cleanup_failed") throw new ControlledTaskCleanupError("verifier", [error]);
    throw error;
  }), id = randomUUID(), name = `cg-verifier-${id}`;
  const visibleArgv = [...spec.testArgv.slice(0, -1), "--test-reporter=tap", spec.visibleTestPath];
  // A candidate that hangs or floods output fails its check; cancellation and daemon errors still propagate.
  // After a timeout the runaway process can still occupy the container (the exec client is gone, the process is not),
  // so no further command is sent there; the verdict is already a rejection and the container is removed below.
  let wedged = false;
  const run = async (args: string[], options: Parameters<ControlledTaskDocker["command"]>[1]): Promise<CommandResult> => {
    try { return await deps.command(args, options); }
    catch (error) {
      if (!signal?.aborted && error instanceof DockerCommandError && (error.reason === "timeout" || error.reason === "output_limit")) { wedged ||= error.reason === "timeout"; return {code: null, stdout: ""}; }
      throw error;
    }
  };
  try {
    signal?.throwIfAborted();
    await seedSoftwareTask(staging, source, spec);
    await deps.checked(["create", "--name", name, "--label", `${controlledOwnerLabel}=${id}`, "--network", "none", "--read-only", "--user", "65532:65532", "--workdir", "/task", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "32", "--cpus", "1", "--init", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--mount", `type=volume,src=${staging.volume},dst=/task,readonly,volume-nocopy`, image, "node", "-e", "setTimeout(()=>process.exit(0),120000)"]);
    await deps.checked(["start", name]);
    signal?.throwIfAborted();
    // (a) the pristine visible tests against the candidate source.
    const visible = await run(["exec", name, ...visibleArgv], {timeoutMs: 30_000, maxBytes: 65_536});
    const visiblePassed = visibleSummary(visible, spec.visibleTestCount);
    signal?.throwIfAborted();
    // (b) host-oracle hidden cases. Random cases are generated after export and
    // expected answers never enter any container; the nonce is per run.
    const cases = spec.hidden.cases(), expected = cases.map(item => spec.hidden.oracle(item));
    const nonce = randomBytes(16).toString("hex");
    const hiddenPassed = !wedged && hiddenResult(await run(["exec", "-i", name, "node", "--experimental-strip-types", "--input-type=module", "-e", spec.hidden.driver],
      {timeoutMs: 10_000, maxBytes: spec.hidden.maxBytes, stdin: Readable.from([Buffer.from(JSON.stringify({nonce, cases}))])}), nonce, expected);
    if (wedged) return {passed: false, cases: cases.length, visible_tests_passed: visiblePassed, hidden_cases_passed: false, candidate_sha256: sha256(source)};
    const files = Object.fromEntries(spec.bundle.files.map(file => [file.path, file.path === spec.writablePath ? sha256(source) : file.sha256]));
    const after = await deps.checked(["exec", name, "node", "-e", softwareHashScript, JSON.stringify(Object.keys(files))], 10_000);
    let same = false;
    try { assert.deepEqual(JSON.parse(after), files); same = true; } catch {}
    if (!same) throw new Error("verifier_candidate_mutated");
    return {passed: visiblePassed && hiddenPassed, cases: cases.length, visible_tests_passed: visiblePassed, hidden_cases_passed: hiddenPassed, candidate_sha256: sha256(source)};
  } finally {
    const failures: unknown[] = [];
    try {
      const found = await deps.checked(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
      if (found) { assert.equal(await deps.checked(["inspect", "--format", `{{index .Config.Labels "${controlledOwnerLabel}"}}`, name]), id); await deps.checked(["rm", "--force", name]); }
    } catch (error) { failures.push(error); }
    try { await staging.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new ControlledTaskCleanupError("verifier", failures);
  }
}
