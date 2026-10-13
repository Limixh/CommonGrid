import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contractHash,
  canonicalContract,
  validateTask,
  validateExecution,
  validateCheckpoint,
  validateProposal,
} from "../src/index";
import type {
  TaskContract,
  ExecutionContext,
  Checkpoint,
  PlannerProposal,
} from "../src/index";
const catalog = JSON.parse(
  readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8"),
);
const cases: {
  name: string;
  patches: [string, unknown][];
  valid: boolean;
  rehash?: boolean;
}[] = JSON.parse(
  readFileSync(new URL("../fixtures/task-cases.json", import.meta.url), "utf8"),
);
const software: TaskContract = catalog.tasks.find(
  (t: TaskContract) => t.type === "software",
);
const plan: TaskContract = catalog.tasks.find(
  (t: TaskContract) => t.kind === "plan",
);
for (const scenario of cases)
  test(scenario.name, async () => {
    const task = structuredClone(software);
    for (const [path, value] of scenario.patches) {
      const parts = path.split(".");
      let cursor: any = task;
      for (const part of parts.slice(0, -1)) cursor = cursor[part];
      cursor[parts.at(-1)!] = value;
    }
    if (scenario.rehash !== false)
      task.contract_hash = await contractHash(task);
    if (scenario.valid) await validateTask(task);
    else await assert.rejects(validateTask(task));
  });
test("all golden fixtures validate in TypeScript", async () => {
  for (const task of catalog.tasks) await validateTask(task);
});
test("hash ignores key order and covers all immutable fields", async () => {
  const reversed = Object.fromEntries(
    Object.entries(software).reverse(),
  ) as TaskContract;
  assert.equal(canonicalContract(reversed), canonicalContract(software));
  assert.equal(await contractHash(reversed), software.contract_hash);
  const changed = { ...software, prompt: software.prompt + "!" };
  assert.notEqual(await contractHash(changed), software.contract_hash);
});
const execution: ExecutionContext = {
  schema_version: "1.0",
  task_id: software.id,
  task_version: 1,
  contract_hash: software.contract_hash,
  lease_id: "lease-1",
  attempt_id: "attempt-1",
  strategy_id: "invariant",
  agent: {
    provider: "codex",
    cli_version: "0.157.1",
    adapter_version: "0.1.0",
    model: "unknown",
    reasoning: "unknown",
    metadata_source: "client_reported",
  },
  effective_limits: { cpu: 1, memory_mb: 256, time_limit_sec: 900 },
  paid_api_allowed: false,
};
test("approved execution context validates", () =>
  assert.equal(validateExecution(execution, software), execution));
for (const [name, change] of Object.entries({
  stale: { task_version: 2 },
  foreign: { contract_hash: "f".repeat(64) },
  strategy: { strategy_id: "unapproved" },
  overBudget: {
    effective_limits: { cpu: 8, memory_mb: 4096, time_limit_sec: 3600 },
  },
  paid: { paid_api_allowed: true },
  promptOverride: { prompt: "different target" },
}))
  test(`execution rejects ${name}`, () =>
    assert.throws(() =>
      validateExecution({ ...execution, ...change }, software),
    ));
const checkpoint: Checkpoint = {
  schema_version: "1.0",
  checkpoint_id: "cp-1",
  task_id: software.id,
  task_version: 1,
  contract_hash: software.contract_hash,
  lease_id: "lease-1",
  type: "hard",
  base_commit: software.workspace.commit,
  summary: "Untrusted summary",
  continuation_instructions: "Untrusted notes",
  artifact_sha256: "a".repeat(64),
};
test("checkpoint binding and unsafe continuation payloads", () => {
  validateCheckpoint(checkpoint, software);
  assert.throws(() =>
    validateCheckpoint({ ...checkpoint, task_version: 2 }, software),
  );
  assert.throws(() =>
    validateCheckpoint(
      { ...checkpoint, base_commit: "b".repeat(40) },
      software,
    ),
  );
  assert.throws(() =>
    validateCheckpoint(
      { ...checkpoint, parent_checkpoint_id: "cp-1" },
      software,
    ),
  );
  assert.throws(() =>
    validateCheckpoint(
      { ...checkpoint, continuation_instructions: "x".repeat(24001) },
      software,
    ),
  );
});
const proposal: PlannerProposal = {
  schema_version: "1.0",
  task_id: plan.id,
  task_version: 1,
  contract_hash: plan.contract_hash,
  target_node_id: plan.node_id,
  relation: "and",
  children: ["lemma-a", "lemma-b"].map((id) => ({
    id,
    goal: `Prove ${id}`,
    depends_on: [],
    verification: catalog.tasks[0].verification,
    strategies: plan.strategies,
    environment: plan.environment,
    progress: { milestones: [] },
  })),
  connection_artifact_sha256: "a".repeat(64),
};
test("proposal validates but does not claim proof correctness", () => {
  validateProposal(proposal, plan);
});
test("proposal rejects cycles, unknown dependencies and duplicated root", () => {
  const cyclic = structuredClone(proposal);
  cyclic.children[0].depends_on = ["lemma-b"];
  cyclic.children[1].depends_on = ["lemma-a"];
  assert.throws(() => validateProposal(cyclic, plan));
  const foreign = structuredClone(proposal);
  foreign.children[0].depends_on = ["outside"];
  assert.throws(() => validateProposal(foreign, plan));
  const root = structuredClone(proposal);
  root.children[0].id = plan.node_id;
  assert.throws(() => validateProposal(root, plan));
});
