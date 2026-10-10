import { useEffect, useMemo, useRef, useState } from "react";
import { validateTask, type TaskContract } from "@commongrid/task-schema";
import { boundedText, type Account } from "./account-api";
import type { Language } from "./language";
import type { Project } from "./ui-types";

export function useTaskCatalog(account: Account, language: Language) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskContract[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "unauthorized">(
    "loading",
  );
  const [source, setSource] = useState<"fixture" | "database" | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [project, setProject] = useState("all");
  const [tab, setTab] = useState<"overview" | "contract">("overview");
  const [strategy, setStrategy] = useState("");
  async function loadCatalog() {
    if (account.state.status === "expired") { setStatus("unauthorized"); return; }
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    const signal = controller.signal;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setStatus("loading");
    setTasks([]); setProjects([]); setSelected(""); setSource(null);
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
      if (projectData.items.length > 1000 || taskData.items.length > 1000) throw new Error("Unexpected catalog size");
      const checkedProjects = projectData.items.map((item: Project) => {
        if (!item || !["lean", "software", "mixed"].includes(item.type) || typeof item.description !== "string" || item.description.length > 20000) throw new Error("Unexpected project");
        return { id: boundedText(item.id), title: boundedText(item.title, 500), type: item.type, description: item.description };
      });
      const valid = await Promise.all(
        taskData.items.map((item: unknown) => validateTask(item)),
      );
      if (catalogRequest.current !== controller) return;
      if (signal.aborted) throw new Error("Catalog timed out");
      setProjects(checkedProjects);
      setTasks(valid);
      setSource(taskData.source);
      setSelected((current) =>
        valid.some((task) => task.id === current)
          ? current
          : (valid[0]?.id ?? ""),
      );
      setStatus("ready");
    } catch (e) {
      if (catalogRequest.current !== controller) return;
      setTasks([]);
      setProjects([]);
      setSelected("");
      setStatus("error");
    } finally { window.clearTimeout(timeout); }
  }
  const accountIdentity = account.state.status === "authenticated" ? account.state.session.user.id : "";
  const accountLoading = account.state.status === "loading";
  const accountExpired = account.state.status === "expired";
  useEffect(() => {
    setQuery(""); setProject("all"); setType("all"); setStrategy(""); setTab("overview");
    setTasks([]); setProjects([]); setSelected(""); setSource(null); setStatus("loading");
    if (accountExpired) setStatus("unauthorized");
    else if (!accountLoading) void loadCatalog();
    return () => { catalogRequest.current?.abort(); catalogRequest.current = null; };
  }, [accountIdentity, accountLoading, accountExpired]);
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (type === "all" || task.type === type) &&
          (project === "all" || task.project_id === project) &&
          (task.title + " " + task.description)
            .toLocaleLowerCase(language)
            .includes(query.toLocaleLowerCase(language)),
      ),
    [tasks, type, project, query, language],
  );
  const task = filtered.find((item) => item.id === selected) ?? filtered[0];
  useEffect(() => {
    setStrategy(task?.strategies[0]?.id ?? "");
    setTab("overview");
  }, [task?.id]);

  return { projects, tasks, status, source, selected, setSelected, query, setQuery, type, setType, project, setProject, tab, setTab, strategy, setStrategy, filtered, task, loadCatalog };
}

export type TaskCatalog = ReturnType<typeof useTaskCatalog>;
