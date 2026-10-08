import Ajv from "ajv";
import { canonicalize } from "json-canonicalize";
import schema from "../schema/contracts.schema.json";
import type {
  TaskContract,
  ExecutionContext,
  Checkpoint,
  PlannerProposal,
} from "./generated";
export type {
  TaskContract,
  ExecutionContext,
  Checkpoint,
  PlannerProposal,
} from "./generated";

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(schema);
function validateShape<T>(name: string, value: unknown): asserts value is T {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;
  if (!validate(value))
    throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
}
export const immutableFields = Object.keys(
  schema.$defs.TaskContract.properties,
).filter((key) => key !== "contract_hash");
export function canonicalContract(task: TaskContract): string {
  const payload = Object.fromEntries(
    immutableFields.map((key) => [key, task[key as keyof TaskContract]]),
  );
  return canonicalize(payload);
}
// Browser-safe SHA-256; Go uses the same RFC 8785 canonical bytes.
export async function contractHash(task: TaskContract): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalContract(task)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function uniqueIds(values: { id: string }[], name: string) {
  if (new Set(values.map((value) => value.id)).size !== values.length)
    throw new Error(`${name}: duplicate id`);
}
export async function validateTask(value: unknown): Promise<TaskContract> {
  validateShape<TaskContract>("TaskContract", value);
  const task = value;
  const expectedProfile =
    task.kind === "plan"
      ? "planner-proposal"
      : task.type === "lean"
        ? "lean-proof"
        : "software-tests";
  const expectedOutput =
    expectedProfile === "lean-proof"
      ? "lean-artifact/1.0"
      : expectedProfile === "software-tests"
        ? "software-diff/1.0"
        : "planner-proposal/1.0";
  if (
    task.verification.profile !== expectedProfile ||
    task.verification.output_schema !== expectedOutput
  )
    throw new Error("verification: kind/type/profile/output mismatch");
  if (task.type === "lean" && task.kind === "rebase")
    throw new Error("rebase is software-only");
  if (task.parallelism.initial > task.parallelism.cap)
    throw new Error("parallelism: initial exceeds cap");
  if (
    task.parallelism.mode === "exclusive" &&
    (task.parallelism.initial !== 1 || task.parallelism.cap !== 1)
  )
    throw new Error("exclusive parallelism must be 1");
  if (task.depends_on.includes(task.id))
    throw new Error("task cannot depend on itself");
  uniqueIds(task.strategies, "strategies");
  uniqueIds(task.progress.milestones, "milestones");
  if (
    task.progress.milestones.reduce((sum, m) => sum + m.weight, 0) >
    1 + 1e-12
  )
    throw new Error("milestone weights exceed 1");
  if (
    task.agents.preferred.some((agent) => task.agents.excluded.includes(agent))
  )
    throw new Error("agent is both preferred and excluded");
  if (task.agents.excluded.length === 2)
    throw new Error("all supported agents excluded");
  if (
    (task.review.policy === "auto") !==
    (task.review.required_approvals === 0)
  )
    throw new Error("review approvals mismatch");
  if (task.kind === "plan" && task.review.policy === "auto")
    throw new Error("planner proposals require human review");
  if (task.review.policy === "auto" && task.type !== "lean")
    throw new Error("automatic acceptance requires a Lean proof");
  if (!task.handoff.enabled && task.handoff.resume_from_latest)
    throw new Error("handoff disabled but resume enabled");
  for (const path of [
    ...task.workspace.entry_files,
    ...task.workspace.writable_paths,
  ]) {
    if (
      path
        .split("/")
        .some(
          (segment) =>
            [".", "..", ".git", ".codex", ".claude"].includes(
              segment.toLowerCase(),
            ) ||
            segment.endsWith(".") ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
        )
    )
      throw new Error("unsafe or protected workspace path");
  }
  if ((await contractHash(task)) !== task.contract_hash)
    throw new Error("contract_hash mismatch");
  return task;
}
function boundTask(
  value: { task_id: string; task_version: number; contract_hash: string },
  task: TaskContract,
) {
  if (
    value.task_id !== task.id ||
    value.task_version !== task.task_version ||
    value.contract_hash !== task.contract_hash
  )
    throw new Error("stale or foreign task contract");
}
export function validateExecution(
  value: unknown,
  task: TaskContract,
): ExecutionContext {
  validateShape<ExecutionContext>("ExecutionContext", value);
  boundTask(value, task);
  if (!task.strategies.some((s) => s.id === value.strategy_id))
    throw new Error("unapproved strategy");
  if (task.agents.excluded.includes(value.agent.provider))
    throw new Error("excluded agent");
  for (const key of ["cpu", "memory_mb", "time_limit_sec"] as const)
    if (value.effective_limits[key] > task.environment[key])
      throw new Error(`effective limit exceeds task: ${key}`);
  return value;
}
export function validateCheckpoint(
  value: unknown,
  task: TaskContract,
): Checkpoint {
  validateShape<Checkpoint>("Checkpoint", value);
  boundTask(value, task);
  if (!task.handoff.enabled || value.base_commit !== task.workspace.commit)
    throw new Error("checkpoint base or handoff mismatch");
  if (value.parent_checkpoint_id === value.checkpoint_id)
    throw new Error("checkpoint cannot reference itself");
  if (value.type === "hard" && !task.handoff.allow_workspace_snapshot)
    throw new Error("workspace snapshot not allowed");
  return value;
}
export function validateProposal(
  value: unknown,
  task: TaskContract,
): PlannerProposal {
  validateShape<PlannerProposal>("PlannerProposal", value);
  boundTask(value, task);
  if (task.kind !== "plan" || value.target_node_id !== task.node_id)
    throw new Error("proposal target mismatch");
  uniqueIds(value.children, "children");
  const children = new Map(value.children.map((c) => [c.id, c]));
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Error("cyclic proposal");
    if (visited.has(id)) return;
    const child = children.get(id);
    if (!child) throw new Error("unknown child dependency");
    if (id === task.node_id || child.goal.trim() === task.description.trim())
      throw new Error("child repeats root");
    uniqueIds(child.strategies, "child strategies");
    uniqueIds(child.progress.milestones, "child milestones");
    if (
      child.progress.milestones.reduce((sum, m) => sum + m.weight, 0) >
      1 + 1e-12
    )
      throw new Error("child milestone weights exceed 1");
    const profile = task.type === "lean" ? "lean-proof" : "software-tests";
    const output =
      task.type === "lean" ? "lean-artifact/1.0" : "software-diff/1.0";
    if (
      child.verification.profile !== profile ||
      child.verification.output_schema !== output
    )
      throw new Error("child verification mismatch");
    active.add(id);
    child.depends_on.forEach(visit);
    active.delete(id);
    visited.add(id);
  }
  value.children.forEach((c) => visit(c.id));
  return value; // Proof of connection, project budgets, depth and existing graph are verified server-side later.
}
