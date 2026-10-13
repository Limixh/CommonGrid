import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import schema from "../schema/contracts.schema.json";
import * as standalone from "../src/validators.generated.js";
import { validateTask } from "../src/index";

const catalog = JSON.parse(readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8"));
const cases: {name: string; patches: [string, unknown][]}[] = JSON.parse(
  readFileSync(new URL("../fixtures/task-cases.json", import.meta.url), "utf8"),
);
const software = catalog.tasks.find((task: {type: string}) => task.type === "software");
const plan = catalog.tasks.find((task: {kind: string}) => task.kind === "plan");
const ajv = new Ajv({allErrors: true, strict: true});
ajv.addSchema(schema);

function parity(name: keyof typeof standalone, value: unknown) {
  const runtime = ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;
  const generated = standalone[name];
  assert.equal(generated(value), runtime(value), `${name}: validation result`);
  assert.deepEqual(generated.errors, runtime.errors, `${name}: all errors and schema paths`);
}

test("standalone task shape results and errors match Ajv for golden and mutation fixtures", () => {
  for (const task of catalog.tasks) parity("TaskContract", task);
  for (const scenario of cases) {
    const task = structuredClone(software);
    for (const [path, value] of scenario.patches) {
      const parts = path.split(".");
      let cursor = task;
      for (const part of parts.slice(0, -1)) cursor = cursor[part];
      cursor[parts.at(-1)!] = value;
    }
    parity("TaskContract", task);
  }
  for (const invalid of [null, [], {}, {...software, title: 1, prompt: null, task_version: -1}])
    parity("TaskContract", invalid);
});

test("all standalone auxiliary schemas preserve refs, Unicode lengths, unknown fields and all errors", () => {
  const execution = {
    schema_version: "1.0", task_id: software.id, task_version: 1, contract_hash: software.contract_hash,
    lease_id: "lease-1", attempt_id: "attempt-1", strategy_id: "invariant",
    agent: {provider: "codex", cli_version: "0.157.1", adapter_version: "0.1.0", model: "unknown", reasoning: "unknown", metadata_source: "client_reported"},
    effective_limits: {cpu: 1, memory_mb: 256, time_limit_sec: 900}, paid_api_allowed: false,
  };
  const checkpoint = {
    schema_version: "1.0", checkpoint_id: "cp-1", task_id: software.id, task_version: 1,
    contract_hash: software.contract_hash, lease_id: "lease-1", type: "hard", base_commit: software.workspace.commit,
    summary: "Untrusted summary", continuation_instructions: "Untrusted notes", artifact_sha256: "a".repeat(64),
  };
  const proposal = {
    schema_version: "1.0", task_id: plan.id, task_version: 1, contract_hash: plan.contract_hash,
    target_node_id: plan.node_id, relation: "and", connection_artifact_sha256: "a".repeat(64),
    children: ["lemma-a", "lemma-b"].map(id => ({
      id, goal: `Prove ${id}`, depends_on: [], verification: catalog.tasks[0].verification,
      strategies: plan.strategies, environment: plan.environment, progress: {milestones: []},
    })),
  };
  assert.equal(standalone.ExecutionContext(execution), true);
  assert.equal(standalone.Checkpoint(checkpoint), true);
  assert.equal(standalone.PlannerProposal(proposal), true);
  for (const value of [execution, {...execution, paid_api_allowed: true}, {...execution, agent: {...execution.agent, cli_version: "😀".repeat(100)}}, {...execution, agent: {...execution.agent, cli_version: "😀".repeat(101)}}, {...execution, effective_limits: {cpu: "one"}, extra: true}, null, {}])
    parity("ExecutionContext", value);
  for (const value of [checkpoint, {...checkpoint, continuation_instructions: "x".repeat(24001)}, {...checkpoint, type: "unknown", artifact_sha256: "bad", extra: true}, null, {}])
    parity("Checkpoint", value);
  for (const value of [proposal, {...proposal, children: []}, {...proposal, relation: "unknown", task_version: 0, extra: true}, {...proposal, children: [{...proposal.children[0], progress: {milestones: [{id: "x", weight: "heavy"}]}}]}, null, {}])
    parity("PlannerProposal", value);
});

test("public shape validation preserves the existing Ajv error text", async () => {
  const malformed = {...software, title: 1, prompt: null, task_version: -1, extra: true};
  const legacy = ajv.getSchema(`${schema.$id}#/$defs/TaskContract`)!;
  assert.equal(legacy(malformed), false);
  const expected = `TaskContract: ${ajv.errorsText(legacy.errors)}`;
  await assert.rejects(validateTask(malformed), error => error instanceof Error && error.message === expected);
});

test("public module imports and all contract semantics run with string code generation forbidden", () => {
  // Run the existing public API suite in a fresh process so no cached import can
  // hide initialization-time eval. The old runtime Ajv import fails this flag.
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--disallow-code-generation-from-strings", "--import", "tsx", "--test", "--test-reporter=tap",
    fileURLToPath(new URL("contracts.test.ts", import.meta.url)),
  ], {cwd: fileURLToPath(new URL("../../../", import.meta.url)), env, encoding: "utf8", timeout: 30000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /# fail 0/);
});
