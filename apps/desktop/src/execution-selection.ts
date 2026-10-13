import type { TaskContract } from "@commongrid/task-schema";
import { taskRunCatalogPins, taskRunStrategyIds, taskRunTaskIds, type TaskRunTaskId } from "@commongrid/agent-adapters/task-run";

export type CatalogExecutionSelection = Readonly<{
  kind: "catalog";
  task: Readonly<Pick<TaskContract, "id" | "title" | "type" | "kind" | "task_version" | "contract_hash"> & {
    base_commit: string;
    strategy_id: string;
  }>;
}>;
export type ControlledExecutionSelection = Readonly<{kind: "controlled"; task_id: TaskRunTaskId}>;
export type ExecutionSelection = CatalogExecutionSelection | ControlledExecutionSelection;

// The controlled task is implemented by the native runner. A catalog contract
// becomes a native run request only through runnableTaskId (exact pinned match).
export const controlledExecutionSelection: ControlledExecutionSelection = Object.freeze({kind: "controlled", task_id: "controlled-sum-integers-v1"});
export function captureCatalogSelection(task: TaskContract, strategyId: string): CatalogExecutionSelection {
  if (!task.strategies.some(strategy => strategy.id === strategyId)) throw new Error("catalog_strategy_invalid");
  return Object.freeze({kind: "catalog", task: Object.freeze({
    id: task.id, title: task.title, type: task.type, kind: task.kind,
    task_version: task.task_version, contract_hash: task.contract_hash,
    base_commit: task.workspace.commit, strategy_id: strategyId,
  })});
}
export function executionSelectionKey(selection: ExecutionSelection): string {
  return JSON.stringify(selection);
}
// The task a selection may start natively, or null. A catalog task qualifies only
// when its id, version and contract hash equal the runner's pinned contract.
// The strategy must also be one of the approved ids of that pinned contract.
export type RunnableSelection = Readonly<{task_id: TaskRunTaskId; strategy_id: string | null}>;
export function runnableSelection(selection: ExecutionSelection): RunnableSelection | null {
  if (selection.kind === "controlled") return {task_id: selection.task_id, strategy_id: null};
  const task = selection.task, id = taskRunTaskIds.find(candidate => candidate === task.id);
  const pin = id ? taskRunCatalogPins[id] : undefined;
  return id && pin && pin.task_version === task.task_version && pin.contract_hash === task.contract_hash &&
    taskRunStrategyIds[id].includes(task.strategy_id) ? {task_id: id, strategy_id: task.strategy_id} : null;
}
export function runnableTaskId(selection: ExecutionSelection): TaskRunTaskId | null {
  return runnableSelection(selection)?.task_id ?? null;
}
