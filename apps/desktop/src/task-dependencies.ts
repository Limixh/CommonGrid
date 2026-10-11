import type { TaskContract } from "@commongrid/task-schema";
import type { UIWords } from "./language";

// Catalog paging and relation helpers. Everything here is a read-only view over
// already validated contracts; statuses live beside the contract, never in it.

export const MAX_CATALOG_PAGES = 20;
export const MAX_CATALOG_ITEMS = 1000;
export const MAX_FOLLOWING_PAGE_ITEMS = 100;
export const MAX_RELATIONS_SHOWN = 50;
const CURSOR = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

export const TASK_STATUSES = ["open", "resumable", "awaiting_review", "accepted", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type StatusKey = TaskStatus | "unknown";
export type StatusMap = ReadonlyMap<string, StatusKey>;

export function statusOf(statuses: StatusMap, id: string): StatusKey {
  return statuses.get(id) ?? "unknown";
}

// Reads the optional `statuses` map of a task list response. Only ids that are
// in this very page count; a value the client does not know is shown as unknown
// instead of being guessed. A map of the wrong shape rejects the whole page.
export function readStatuses(raw: unknown, pageIds: ReadonlySet<string>): Map<string, StatusKey> {
  const result = new Map<string, StatusKey>();
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Unexpected statuses");
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || value.length > 64) throw new Error("Unexpected status");
    if (!pageIds.has(id)) continue;
    result.set(id, (TASK_STATUSES as readonly string[]).includes(value) ? (value as TaskStatus) : "unknown");
  }
  return result;
}

export function readCursor(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || !CURSOR.test(raw)) throw new Error("Unexpected cursor");
  return raw;
}

export function pageUrl(base: string, cursor: string): string {
  return cursor ? `${base}?after=${encodeURIComponent(cursor)}` : base;
}

export function kindLabel(t: UIWords, kind: TaskContract["kind"]): string {
  switch (kind) {
    case "plan": return t.plan;
    case "solve": return t.solve;
    case "refute": return t.kindRefute;
    case "rebase": return t.kindRebase;
    default: return t.kindUnknown;
  }
}

export function statusLabel(t: UIWords, status: StatusKey): string {
  switch (status) {
    case "open": return t.statusOpen;
    case "resumable": return t.statusResumable;
    case "awaiting_review": return t.statusAwaitingReview;
    case "accepted": return t.statusAccepted;
    case "archived": return t.statusArchived;
    default: return t.statusUnknown;
  }
}

// visible: in the current list. filtered: loaded but hidden by the filters.
// unloaded: not loaded yet and the catalog is incomplete (including a paging
// cap or loop). absent: the whole catalog is
// loaded and the id is not in it.
export type RelationState = "visible" | "filtered" | "unloaded" | "absent";
export type Relation = { id: string; state: RelationState; task?: TaskContract; status: StatusKey };
export type Relations = {
  prerequisites: Relation[];
  dependents: Relation[];
  hiddenDependents: number;
  dependentsComplete: boolean;
};

export function relationsOf(
  task: TaskContract,
  tasks: readonly TaskContract[],
  visibleIds: ReadonlySet<string>,
  statuses: StatusMap,
  incomplete: boolean,
): Relations {
  const byId = new Map<string, TaskContract>();
  for (const item of tasks) if (!byId.has(item.id)) byId.set(item.id, item);
  const describe = (id: string): Relation => {
    const found = byId.get(id);
    if (!found) return { id, state: incomplete ? "unloaded" : "absent", status: "unknown" };
    return { id, task: found, state: visibleIds.has(id) ? "visible" : "filtered", status: statusOf(statuses, id) };
  };
  const prerequisites = [...new Set(task.depends_on)].filter((id) => id !== task.id).map(describe);
  const dependents = tasks
    .filter((item) => item.id !== task.id && item.depends_on.includes(task.id))
    .map((item) => describe(item.id));
  return {
    prerequisites,
    dependents: dependents.slice(0, MAX_RELATIONS_SHOWN),
    hiddenDependents: Math.max(0, dependents.length - MAX_RELATIONS_SHOWN),
    dependentsComplete: !incomplete,
  };
}
