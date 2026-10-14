import { useEffect, useMemo, useRef, useState } from "react";
import { validateTask, type TaskContract } from "@commongrid/task-schema";
import { boundedText, type Account } from "./account-api";
import type { Language } from "./language";
import {
  MAX_CATALOG_ITEMS,
  MAX_CATALOG_PAGES,
  MAX_FOLLOWING_PAGE_ITEMS,
  pageUrl,
  readCursor,
  readStatuses,
  statusOf,
  type StatusKey,
} from "./task-dependencies";
import type { Project } from "./ui-types";
import { readExecutionCapabilities, type ExecutionCapabilities } from "./central-execution-client";

type ListName = "projects" | "tasks";
type MoreState = "idle" | "loading" | "error";
export type Pager = { hasMore: boolean; state: MoreState; loop: boolean; capped: boolean };
const IDLE: Pager = { hasMore: false, state: "idle", loop: false, capped: false };
const REQUEST_TIMEOUT_MS = 10_000;

function checkProject(item: Project): Project {
  if (!item || !["lean", "software", "mixed"].includes(item.type) || typeof item.description !== "string" || item.description.length > 20000) throw new Error("Unexpected project");
  return { id: boundedText(item.id), title: boundedText(item.title, 500), type: item.type, description: item.description };
}

// Appends only records whose id is new (first occurrence wins) and never grows
// the list beyond the catalog item bound.
function mergeUnique<T extends { id: string }>(existing: T[], incoming: T[]) {
  const seen = new Set(existing.map((item) => item.id));
  const added: T[] = [];
  let duplicates = 0;
  let capped = false;
  for (const item of incoming) {
    if (seen.has(item.id)) { duplicates++; continue; }
    if (existing.length + added.length >= MAX_CATALOG_ITEMS) { capped = true; continue; }
    seen.add(item.id);
    added.push(item);
  }
  return { added, duplicates, capped };
}

export function useTaskCatalog(account: Account, language: Language) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskContract[]>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, StatusKey>>(new Map());
  const [pagers, setPagers] = useState<Record<ListName, Pager>>({ projects: IDLE, tasks: IDLE });
  const [duplicates, setDuplicates] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "unauthorized">(
    "loading",
  );
  const [source, setSource] = useState<"fixture" | "database" | null>(null);
  const [executionCapabilities, setExecutionCapabilities] = useState<ExecutionCapabilities>(new Map());
  const catalogRequest = useRef<AbortController | null>(null);
  // Canonical paging state. Refs keep cursor/duplicate decisions correct across
  // overlapping responses; React state is only a rendered copy.
  const paging = useRef({
    generation: 0,
    ready: false,
    source: null as "fixture" | "database" | null,
    projects: [] as Project[],
    tasks: [] as TaskContract[],
    statuses: new Map<string, StatusKey>(),
    executionCapabilities: new Map() as Map<string, import("./central-execution-client").ExecutionCapability>,
    cursor: { projects: "", tasks: "" } as Record<ListName, string>,
    used: { projects: new Set<string>(), tasks: new Set<string>() } as Record<ListName, Set<string>>,
    pages: { projects: 1, tasks: 1 } as Record<ListName, number>,
    busy: { projects: false, tasks: false } as Record<ListName, boolean>,
    failed: { projects: false, tasks: false } as Record<ListName, boolean>,
    capped: { projects: false, tasks: false } as Record<ListName, boolean>,
    loop: { projects: false, tasks: false } as Record<ListName, boolean>,
    duplicates: 0,
    requests: new Set<AbortController>(),
  });
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [project, setProject] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [tab, setTab] = useState<"overview" | "contract">("overview");
  const [strategy, setStrategy] = useState("");

  function resetPaging() {
    const p = paging.current;
    p.generation++;
    p.ready = false;
    p.source = null;
    p.projects = []; p.tasks = []; p.statuses = new Map();
    p.executionCapabilities = new Map();
    p.cursor = { projects: "", tasks: "" };
    p.used = { projects: new Set(), tasks: new Set() };
    p.pages = { projects: 1, tasks: 1 };
    p.busy = { projects: false, tasks: false };
    p.failed = { projects: false, tasks: false };
    p.capped = { projects: false, tasks: false };
    p.loop = { projects: false, tasks: false };
    p.duplicates = 0;
    for (const controller of p.requests) controller.abort();
    p.requests.clear();
  }
  function publishPagers() {
    const p = paging.current;
    const make = (list: ListName): Pager => ({ hasMore: p.cursor[list] !== "", state: p.busy[list] ? "loading" : p.failed[list] ? "error" : "idle", loop: p.loop[list], capped: p.capped[list] });
    setPagers({ projects: make("projects"), tasks: make("tasks") });
    setDuplicates(p.duplicates);
  }
  function clearAll() {
    resetPaging();
    setTasks([]); setProjects([]); setStatuses(new Map()); setSelected(""); setSource(null);
    setExecutionCapabilities(new Map());
    setPagers({ projects: IDLE, tasks: IDLE }); setDuplicates(0);
  }

  async function loadCatalog() {
    if (account.state.status === "expired") { setStatus("unauthorized"); return; }
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    const signal = controller.signal;
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    setStatus("loading");
    clearAll();
    const generation = paging.current.generation;
    try {
      const responses = await Promise.all([
        fetch("/api/v1/projects", { signal, credentials: "same-origin" }),
        fetch("/api/v1/tasks", { signal, credentials: "same-origin" }),
      ]);
      if (catalogRequest.current !== controller) return;
      if (responses.some((r) => r.status === 401)) {
        setStatus("unauthorized");
        if (account.state.status === "authenticated") account.expire();
        return;
      }
      if (responses.some((r) => !r.ok)) throw new Error("API response failed");
      const [projectData, taskData] = await Promise.all(
        responses.map((r) => r.json()),
      );
      if (catalogRequest.current !== controller) return;
      if (taskData?.source === "database" && account.state.status !== "authenticated") {
        setStatus("unauthorized");
        return;
      }
      if (
        !["fixture", "database"].includes(taskData.source) ||
        projectData.source !== taskData.source ||
        taskData.execution_enabled !== false ||
        !Array.isArray(projectData.items) ||
        !Array.isArray(taskData.items)
      )
        throw new Error("Unexpected catalog contract");
      if (projectData.items.length > MAX_CATALOG_ITEMS || taskData.items.length > MAX_CATALOG_ITEMS) throw new Error("Unexpected catalog size");
      const checkedProjects: Project[] = projectData.items.map(checkProject);
      const valid: TaskContract[] = await Promise.all(
        taskData.items.map((item: unknown) => validateTask(item)),
      );
      const capabilities = readExecutionCapabilities(taskData.execution_capabilities, valid, taskData.source);
      if (catalogRequest.current !== controller || paging.current.generation !== generation) return;
      if (signal.aborted) throw new Error("Catalog timed out");
      const nextProjects = readCursor(projectData.next_cursor);
      const nextTasks = readCursor(taskData.next_cursor);
      if ((nextProjects && checkedProjects.length === 0) || (nextTasks && valid.length === 0)) throw new Error("Unexpected cursor");
      const p = paging.current;
      const mergedProjects = mergeUnique([], checkedProjects);
      const mergedTasks = mergeUnique([], valid);
      p.projects = mergedProjects.added;
      p.tasks = mergedTasks.added;
      p.statuses = readStatuses(taskData.statuses, new Set(p.tasks.map((item) => item.id)));
      p.executionCapabilities = new Map(capabilities);
      p.duplicates = mergedProjects.duplicates + mergedTasks.duplicates;
      p.cursor = { projects: nextProjects, tasks: nextTasks };
      p.capped = { projects: mergedProjects.capped, tasks: mergedTasks.capped };
      if (p.capped.projects) p.cursor.projects = "";
      if (p.capped.tasks) p.cursor.tasks = "";
      p.source = taskData.source;
      p.ready = true;
      setProjects(p.projects);
      setTasks(p.tasks);
      setStatuses(p.statuses);
      setExecutionCapabilities(p.executionCapabilities);
      setSource(taskData.source);
      publishPagers();
      setSelected((current) =>
        p.tasks.some((task) => task.id === current)
          ? current
          : (p.tasks[0]?.id ?? ""),
      );
      setStatus("ready");
    } catch (e) {
      if (catalogRequest.current !== controller) return;
      clearAll();
      setStatus("error");
    } finally { window.clearTimeout(timeout); }
  }

  // Loads the next page of one list. Projects and tasks have independent
  // cursors; a failure keeps what is already loaded and the same cursor.
  async function loadMore(list: ListName) {
    const p = paging.current;
    const cursor = p.cursor[list];
    if (!p.ready || !cursor || p.busy[list]) return;
    const generation = p.generation;
    const live = () => paging.current.generation === generation;
    const controller = new AbortController();
    p.requests.add(controller);
    p.busy[list] = true;
    p.failed[list] = false;
    publishPagers();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      p.used[list].add(cursor);
      const response = await fetch(pageUrl(`/api/v1/${list}`, cursor), { signal: controller.signal, credentials: "same-origin" });
      if (!live()) return;
      if (response.status === 401) {
        clearAll();
        setStatus("unauthorized");
        if (account.state.status === "authenticated") account.expire();
        return;
      }
      if (!response.ok) throw new Error("API response failed");
      const data = await response.json();
      if (!live()) return;
      if (data?.source !== p.source || !Array.isArray(data.items) || data.items.length > MAX_FOLLOWING_PAGE_ITEMS) throw new Error("Unexpected page");
      if (list === "tasks" && data.execution_enabled !== false) throw new Error("Unexpected page");
      const next = readCursor(data.next_cursor);
      let incoming: Project[] | TaskContract[];
      let pageStatuses = new Map<string, StatusKey>();
      let pageCapabilities: ExecutionCapabilities = new Map();
      if (list === "projects") incoming = (data.items as Project[]).map(checkProject);
      else {
        incoming = await Promise.all((data.items as unknown[]).map((item) => validateTask(item)));
        pageStatuses = readStatuses(data.statuses, new Set(incoming.map((item) => item.id)));
        pageCapabilities = readExecutionCapabilities(data.execution_capabilities, incoming as TaskContract[], data.source);
      }
      if (!live()) return;
      if (controller.signal.aborted) throw new Error("Page timed out");
      const merged = mergeUnique<{ id: string }>(p[list], incoming);
      if (list === "projects") p.projects = [...p.projects, ...(merged.added as Project[])];
      else {
        p.tasks = [...p.tasks, ...(merged.added as TaskContract[])];
        for (const added of merged.added) {
          const value = pageStatuses.get(added.id);
          if (value) p.statuses.set(added.id, value);
          const capability = pageCapabilities.get(added.id);
          if (capability) p.executionCapabilities.set(added.id, capability);
        }
      }
      p.duplicates += merged.duplicates;
      p.pages[list]++;
      // The server continues with a cursor we already used, or a page gave
      // nothing new: stop instead of looping against it.
      if (next && (p.used[list].has(next) || merged.added.length === 0)) { p.loop[list] = true; p.cursor[list] = ""; }
      else if (next && (merged.capped || p.pages[list] >= MAX_CATALOG_PAGES || p[list].length >= MAX_CATALOG_ITEMS)) { p.capped[list] = true; p.cursor[list] = ""; }
      else p.cursor[list] = next;
      if (list === "projects") setProjects(p.projects);
      else { setTasks(p.tasks); setStatuses(new Map(p.statuses)); setExecutionCapabilities(new Map(p.executionCapabilities)); }
      publishPagers();
    } catch {
      if (live()) p.failed[list] = true;
    } finally {
      window.clearTimeout(timeout);
      p.requests.delete(controller);
      if (live()) { p.busy[list] = false; publishPagers(); }
    }
  }

  const accountIdentity = account.state.status === "authenticated" ? account.state.session.user.id : "";
  const accountLoading = account.state.status === "loading";
  const accountExpired = account.state.status === "expired";
  useEffect(() => {
    setQuery(""); setProject("all"); setType("all"); setStatusFilter("all"); setStrategy(""); setTab("overview");
    clearAll(); setStatus("loading");
    if (accountExpired) setStatus("unauthorized");
    else if (!accountLoading) void loadCatalog();
    return () => { catalogRequest.current?.abort(); catalogRequest.current = null; resetPaging(); };
  }, [accountIdentity, accountLoading, accountExpired]);
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (type === "all" || task.type === type) &&
          (project === "all" || task.project_id === project) &&
          (statusFilter === "all" || statusOf(statuses, task.id) === statusFilter) &&
          (task.title + " " + task.description)
            .toLocaleLowerCase(language)
            .includes(query.toLocaleLowerCase(language)),
      ),
    [tasks, type, project, statusFilter, statuses, query, language],
  );
  const task = filtered.find((item) => item.id === selected) ?? filtered[0];
  useEffect(() => {
    setStrategy(task?.strategies[0]?.id ?? "");
    setTab("overview");
  }, [task?.id]);
  // Selects a related task even when the current filters would hide it.
  function revealTask(id: string) {
    setQuery(""); setType("all"); setProject("all"); setStatusFilter("all");
    setSelected(id);
  }

  return {
    projects, tasks, statuses, status, source, executionCapabilities, selected, setSelected, query, setQuery, type, setType, project, setProject,
    statusFilter, setStatusFilter, tab, setTab, strategy, setStrategy, filtered, task, loadCatalog,
    pagers, duplicates, loadMoreTasks: () => loadMore("tasks"), loadMoreProjects: () => loadMore("projects"), revealTask,
  };
}

export type TaskCatalog = ReturnType<typeof useTaskCatalog>;
