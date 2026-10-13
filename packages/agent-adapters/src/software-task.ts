// Catalog task `software-bounds` (lowerBound) run through the same native
// approved-run flow as the controlled sum.mjs task. The task files come from a
// pinned local bundle (task-assets/software-bounds) whose synthetic git commit
// is the catalog contract's workspace.commit: nothing is cloned or downloaded.
// The agent sees only /task/{package.json,src/search.ts,tests/search.test.ts}
// and may change src/search.ts alone. Hidden cases and their expected answers
// stay on the host; the verifier container is offline, read-only and throwaway.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { validateTask, type TaskContract } from "@commongrid/task-schema";
import catalog from "../../task-schema/fixtures/catalog.json";
import { gitFixtureIds } from "./git-object-ids.mjs";
import { softwareBoundsBundle } from "./software-bounds-bundle.generated.ts";
import { DockerCommandError } from "./task-runtime.ts";
import { ControlledTaskCleanupError, controlledOwnerLabel, controlledTaskExecDescription, controlledVerifierDeps, snapshotControlledCandidate, type ControlledTaskDocker, type ControlledVerifierDeps } from "./controlled-task.ts";
import { taskCandidateSnapshotScript, validateControlledCandidateSource, type TaskSnapshotSpec } from "./controlled-task-artifact.ts";
import { canonicalPinnedImageReference } from "./pinned-image.ts";
import { taskRunCatalogPins, taskRunStrategyIds } from "./task-run-protocol.ts";
import type { TaskToolsRuntime } from "./task-runtime.ts";

export const softwareBoundsTaskId = "software-bounds";
export const softwareWritablePath = "src/search.ts";
export const softwareEntryFiles: readonly string[] = Object.freeze(["src/search.ts", "tests/search.test.ts"]);
// Substring matched on the candidate source (catalog verification.forbidden_patterns).
export const softwareForbiddenPatterns: readonly string[] = Object.freeze(["child_process", "node:fs", "process.exit"]);
// What the agent is told to run; the verifier adds a TAP reporter so it can read the test count.
export const softwareTestArgv: readonly string[] = Object.freeze(["node", "--experimental-strip-types", "--test", "tests/search.test.ts"]);
export const softwareTestCommand = softwareTestArgv.join(" ");
// Bounded by the Windows command line: the candidate travels as one docker exec argument.
export const softwareCandidateJsonLimit = 12_000;
export const softwareVerifierCases = 40;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const bundleFile = (path: string) => {
  const file = softwareBoundsBundle.files.find(item => item.path === path);
  if (!file) throw new Error("software_bundle_file_missing");
  return file;
};
/** The pristine, deliberately buggy baseline of the one writable file. */
export const softwareBaseline: string = bundleFile(softwareWritablePath).content;
const visibleTestSource = bundleFile("tests/search.test.ts").content;
export const softwareVisibleTestCount = (visibleTestSource.match(/^test\(/gm) ?? []).length;
/** The unvalidated catalog entry; verifySoftwareBundle binds it to the pinned bundle and contract hash. */
export const softwareBoundsTask: unknown = (catalog as {tasks: Array<{id: string}>}).tasks.find(task => task.id === softwareBoundsTaskId);

// ---- Contract binding ------------------------------------------------------

/** A bundle/contract mismatch. The native worker reports it as asset_invalid; `reason` is for tests only. */
export class SoftwareBundleError extends Error {
  readonly code = "asset_invalid";
  constructor(readonly reason: string) { super("software_bundle_invalid"); }
}
export interface SoftwareBundlePin { task_version: number; contract_hash: string; /** Image the native runtime actually uses. */ image: string }
export type SoftwareBundle = typeof softwareBoundsBundle;
const equalLists = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Proves, before any Docker call, that the catalog contract is the exact one
 * the runner implements: pinned id/version/hash, the bundle's recomputed git
 * commit, paths, approved strategy ids, forbidden patterns, image and limits.
 */
export async function verifySoftwareBundle(value: unknown, pin: SoftwareBundlePin | undefined, bundle: SoftwareBundle = softwareBoundsBundle): Promise<TaskContract> {
  const fail = (reason: string): never => { throw new SoftwareBundleError(reason); };
  if (!pin || !Number.isSafeInteger(pin.task_version) || typeof pin.contract_hash !== "string" || typeof pin.image !== "string") fail("pin");
  let task: TaskContract;
  try { task = await validateTask(value); } catch { return fail("contract"); }
  if (task.id !== softwareBoundsTaskId || task.type !== "software" || task.kind !== "solve") fail("identity");
  if (task.task_version !== pin!.task_version || task.contract_hash !== pin!.contract_hash) fail("pin");
  for (const file of bundle.files) if (sha256(file.content) !== file.sha256) fail("bundle_file");
  const ids = gitFixtureIds(bundle.files);
  if (ids.commit !== bundle.git.commit || ids.tree !== bundle.git.tree || ids.commit !== task.workspace.commit) fail("commit");
  const paths: string[] = bundle.files.map(file => file.path);
  if (!equalLists(paths, ["package.json", "src/search.ts", "tests/search.test.ts"]) || !softwareEntryFiles.every(path => paths.includes(path))) fail("bundle_files");
  if (!equalLists(task.workspace.entry_files, softwareEntryFiles) || !equalLists(task.workspace.writable_paths, [softwareWritablePath])) fail("paths");
  // The ids the protocol lets the UI name must be exactly the contract's, in order; instructions stay in the hash-verified contract.
  if (!equalLists(task.strategies.map(item => item.id), taskRunStrategyIds[softwareBoundsTaskId])) fail("strategies");
  if (!equalLists(task.verification.forbidden_patterns, softwareForbiddenPatterns)) fail("forbidden_patterns");
  if (task.verification.local_precheck !== softwareTestCommand || task.verification.server_command !== softwareTestCommand) fail("command");
  let image: string, pinned: string;
  try { image = canonicalPinnedImageReference(task.environment.image); pinned = canonicalPinnedImageReference(pin!.image); } catch { return fail("image"); }
  if (image !== pinned) fail("image");
  if (task.environment.cpu !== 1 || task.environment.memory_mb !== 256 || task.environment.time_limit_sec !== 1200) fail("limits");
  return task;
}
/** Verifies the shipped catalog entry against the runner's pin for the image in use. */
export function verifyCatalogSoftwareBundle(image: string): Promise<TaskContract> {
  const pin = taskRunCatalogPins[softwareBoundsTaskId];
  return verifySoftwareBundle(softwareBoundsTask, pin && {...pin, image});
}

export const softwareHarnessInstructions = "Workspace: the working directory is /task. Edit only /task/src/search.ts, using only task_exec. The visible tests in /task/tests/search.test.ts and /task/package.json must not be edited, and no other file may be created. Run the visible tests with argv " +
  JSON.stringify(softwareTestArgv) + " (Node strips types, so use erasable TypeScript syntax only). Additional independent checks run elsewhere. Report a short completion.";
export type SoftwareStrategy = TaskContract["strategies"][number];
/** Fixed wording after a contract strategy; the strategy guides the approach only. */
export const softwareStrategyNotice = "This strategy only guides your approach; it does not change the task or its acceptance criteria.";
/** The contract's own entry for a strategy id, or undefined. Only the id crosses the UI boundary. */
export function findSoftwareStrategy(contract: Pick<TaskContract, "strategies">, strategyId: string | null): SoftwareStrategy | undefined {
  return contract.strategies.find(item => item.id === strategyId);
}
/**
 * The catalog prompt, the approved strategy block taken verbatim from the
 * verified contract, then the fixed harness description; neither the contract
 * nor the strategy can change the tool contract.
 */
export function softwareTaskPrompt(contract: Pick<TaskContract, "prompt">, strategy: SoftwareStrategy): string {
  return `${contract.prompt}\n\nApproved strategy (${strategy.id}): ${strategy.instructions}\n${softwareStrategyNotice}\n\n${softwareHarnessInstructions}\n\nTask tool contract: ${controlledTaskExecDescription}`;
}

// ---- Seeding ---------------------------------------------------------------

type Exec = Pick<TaskToolsRuntime, "exec">;
const writeScript = "const fs=require('node:fs'),path=require('node:path'),[name,text]=JSON.parse(process.argv[1]),target='/task/'+name;fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text,{flag:'wx'});";
/** Writes the pristine bundle (one exec per file); `candidate` replaces only the writable file. */
export async function seedSoftwareTask(runtime: Exec, candidate?: string): Promise<void> {
  for (const file of softwareBoundsBundle.files) {
    const content = candidate !== undefined && file.path === softwareWritablePath ? candidate : file.content;
    const result = await runtime.exec(["node", "-e", writeScript, JSON.stringify([file.path, content])]);
    assert.equal(result.code, 0, "software_task_seed_failed");
  }
}

// ---- Candidate policy and snapshot -----------------------------------------

/** Host-side policy on top of the exporter's content policy. Errors start with `candidate_`. */
export function assertSoftwareCandidate(source: string): void {
  validateControlledCandidateSource(source);
  if (Buffer.byteLength(JSON.stringify(source)) > softwareCandidateJsonLimit) throw new Error("candidate_limit");
  if (softwareForbiddenPatterns.some(pattern => source.includes(pattern))) throw new Error("candidate_forbidden_pattern");
}
export const softwareSnapshotSpec: TaskSnapshotSpec = Object.freeze({
  files: Object.freeze(softwareBoundsBundle.files.map(file => Object.freeze({path: file.path, sha256: file.path === softwareWritablePath ? null : file.sha256}))),
});
export const softwareSnapshotScript = taskCandidateSnapshotScript(softwareSnapshotSpec);
/** Freezes the task, exports src/search.ts through the read-only exporter and applies the host policy. */
export async function snapshotSoftwareCandidate(runtime: Parameters<typeof snapshotControlledCandidate>[0], image: string, docker?: ControlledTaskDocker): Promise<string> {
  const source = await snapshotControlledCandidate(runtime, image, docker, softwareSnapshotScript);
  assertSoftwareCandidate(source);
  if (source === softwareBaseline) throw new Error("candidate_unchanged");
  return source;
}

// ---- Independent verifier --------------------------------------------------

/** Host oracle: first index with values[i] >= target, else values.length. */
export function lowerBoundOracle(values: readonly number[], target: number): number {
  for (let index = 0; index < values.length; index++) if (values[index] >= target) return index;
  return values.length;
}
export interface SoftwareHiddenCase { values: number[]; target: number }
const fixedCases: ReadonlyArray<readonly [number[], number]> = [
  [[], 0], [[], -5], [[5], 4], [[5], 5], [[5], 6], [[2, 2, 2, 2], 1], [[2, 2, 2, 2], 2], [[2, 2, 2, 2], 3],
  [[1, 3, 5, 7, 9], 0], [[1, 3, 5, 7, 9], 10], [[1, 3, 5, 7, 9], 9], [[1, 3, 5, 7, 9], 1], [[1, 3, 5, 7, 9], 4],
  [[-9, -4, -4, -1, 0, 0, 3], -4], [[-9, -4, -4, -1, 0, 0, 3], -5], [[-9, -4, -4, -1, 0, 0, 3], 0],
  [[1, 2, 2, 2, 2, 3], 2], [[1, 2], 3],
  [[Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER], [[Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER], Number.MIN_SAFE_INTEGER],
];
const randomCases = softwareVerifierCases - fixedCases.length;
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
export const softwareHashScript = "const fs=require('node:fs'),crypto=require('node:crypto'),out={};for(const name of JSON.parse(process.argv[1]))out[name]=crypto.createHash('sha256').update(fs.readFileSync('/task/'+name)).digest('hex');console.log(JSON.stringify(out));";
const visibleArgv = ["node", "--experimental-strip-types", "--test", "--test-reporter=tap", "tests/search.test.ts"];

export interface SoftwareVerifierResult { passed: boolean; cases: number; visible_tests_passed: boolean; hidden_cases_passed: boolean; candidate_sha256: string }
type CommandResult = Awaited<ReturnType<ControlledTaskDocker["command"]>>;
// The last summary lines belong to the test runner itself; candidate output is printed earlier.
function visibleSummary(result: CommandResult): boolean {
  if (result.code !== 0) return false;
  const last = (key: string) => {
    const found = [...result.stdout.matchAll(new RegExp(`^# ${key} (\\d+)$`, "gm"))];
    return found.length ? Number(found[found.length - 1][1]) : -1;
  };
  return last("tests") === softwareVisibleTestCount && last("pass") === softwareVisibleTestCount && last("fail") === 0;
}
function hiddenResult(result: CommandResult, nonce: string, expected: number[]): boolean {
  if (result.code !== 0) return false;
  const prefix = `CGR ${nonce} `, lines = result.stdout.split("\n").filter(line => line.startsWith(prefix));
  if (lines.length !== 1) return false;
  try { assert.deepEqual(JSON.parse(lines[0].slice(prefix.length)), expected); return true; } catch { return false; }
}

/** Verifies a candidate against the pristine visible tests and host-generated hidden cases in a throwaway offline container. */
export async function verifySoftwareCandidate(source: string, image: string, deps: ControlledVerifierDeps = controlledVerifierDeps, signal?: AbortSignal): Promise<SoftwareVerifierResult> {
  assertSoftwareCandidate(source);
  signal?.throwIfAborted();
  const staging = await deps.staging(image).catch(error => {
    if (error instanceof AggregateError && error.message === "sandbox_cleanup_failed") throw new ControlledTaskCleanupError("verifier", [error]);
    throw error;
  }), id = randomUUID(), name = `cg-verifier-${id}`;
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
    await seedSoftwareTask(staging, source);
    await deps.checked(["create", "--name", name, "--label", `${controlledOwnerLabel}=${id}`, "--network", "none", "--read-only", "--user", "65532:65532", "--workdir", "/task", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "32", "--cpus", "1", "--init", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--mount", `type=volume,src=${staging.volume},dst=/task,readonly,volume-nocopy`, image, "node", "-e", "setTimeout(()=>process.exit(0),120000)"]);
    await deps.checked(["start", name]);
    signal?.throwIfAborted();
    // (a) the pristine visible tests against the candidate source.
    const visible = await run(["exec", name, ...visibleArgv], {timeoutMs: 30_000, maxBytes: 65_536});
    const visiblePassed = visibleSummary(visible);
    signal?.throwIfAborted();
    // (b) host-oracle hidden cases. Random cases are generated after export and
    // expected answers never enter any container; the nonce is per run.
    const cases = softwareHiddenCases(), expected = cases.map(item => lowerBoundOracle(item.values, item.target));
    const nonce = randomBytes(16).toString("hex");
    const hiddenPassed = !wedged && hiddenResult(await run(["exec", "-i", name, "node", "--experimental-strip-types", "--input-type=module", "-e", softwareHiddenDriver],
      {timeoutMs: 10_000, maxBytes: 16_384, stdin: Readable.from([Buffer.from(JSON.stringify({nonce, cases}))])}), nonce, expected);
    if (wedged) return {passed: false, cases: cases.length, visible_tests_passed: visiblePassed, hidden_cases_passed: false, candidate_sha256: sha256(source)};
    const files = Object.fromEntries(softwareBoundsBundle.files.map(file => [file.path, file.path === softwareWritablePath ? sha256(source) : file.sha256]));
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
