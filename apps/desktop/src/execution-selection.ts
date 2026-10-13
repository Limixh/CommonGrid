import type { TaskContract } from "@commongrid/task-schema";
import type { TaskRunTaskId } from "@commongrid/agent-adapters/task-run";

export type CatalogExecutionSelection = Readonly<{
  kind: "catalog";
  task: Readonly<Pick<TaskContract, "id" | "title" | "type" | "kind" | "task_version" | "contract_hash"> & {
    base_commit: string;
    strategy_id: string;
  }>;
}>;
export type ControlledExecutionSelection = Readonly<{kind: "controlled"; task_id: TaskRunTaskId}>;
export type ExecutionSelection = CatalogExecutionSelection | ControlledExecutionSelection;

// This local task is implemented by the native runner. Catalog contracts are
// captured for profile preparation only; they never become native run requests.
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
