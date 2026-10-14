import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import type { UIWords } from "./language";
import { TaskDependenciesPanel, StatusBadge } from "./TaskDependenciesPanel";
import { kindLabel, statusOf, TASK_STATUSES, statusLabel } from "./task-dependencies";
import type { Settings, Page } from "./ui-types";
import type { TaskCatalog } from "./useTaskCatalog";
import { useRunLimits } from "./useRunLimits";
import { captureCatalogSelection, controlledExecutionSelection, type ExecutionSelection } from "./execution-selection";

type WorkspacePageProps = { catalog: TaskCatalog; settings: Settings; t: UIWords; setPage: (page: Page) => void; onPrepareExecution: (selection: ExecutionSelection) => void };

export function WorkspacePage({ catalog, settings, t, setPage, onPrepareExecution }: WorkspacePageProps) {
  const { projects, tasks, statuses, status, source, setSelected, query, setQuery, type, setType, project, setProject, statusFilter, setStatusFilter, tab, setTab, strategy, setStrategy, filtered, task, loadCatalog, pagers, duplicates, loadMoreTasks, loadMoreProjects, revealTask } = catalog;
  // The native ledger's effective maximum replaces the browser copy of the user limits when it answers.
  const runLimits = useRunLimits().status;
  const nativeMaxSec = runLimits?.availability === "available" && runLimits.effective.reason !== "local_budget_unavailable" ? runLimits.effective.max_sec : null;
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const focusDetail = useRef(false);
  const visibleIds = new Set(filtered.map((item) => item.id));
  // After a relation link the old button may be gone, so keyboard users land on the new task heading.
  useEffect(() => {
    if (focusDetail.current) { focusDetail.current = false; detailHeading.current?.focus(); }
  }, [task?.id]);
  function openRelation(id: string) {
    focusDetail.current = true;
    revealTask(id);
    if (task?.id === id) { focusDetail.current = false; detailHeading.current?.focus(); }
  }
  const taskMore = pagers.tasks;
  const projectMore = pagers.projects;
  return (
    <div className="workspace-content">
      <section className="hero">
        <div>
          <div className="eyebrow">
            <span className="tiny-line" />
            {t.eyebrow}
          </div>
          <h1>
            {t.hero}
            <br />
            <span>{t.hero2}</span>
          </h1>
          <p>{t.subtitle}</p>
        </div>
        <div className="hero-graphic" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="graph-node gn1">∑</div>
          <div className="graph-node gn2">{"{ }"}</div>
          <div className="graph-node gn3">λ</div>
          <div className="graph-node center-node">
            <Icon name="grid" size={35} />
          </div>
          <div className="graph-node gn4">✓</div>
          <div className="graph-node gn5">∞</div>
          <span className="graph-label">COMMON / GRID</span>
        </div>
      </section>
      <section className="local-controlled-task" aria-labelledby="local-controlled-task-title">
        <div><h2 id="local-controlled-task-title">{t.controlledTaskTitle}</h2><p>{t.controlledTaskText}</p></div>
        <button className="secondary-button" onClick={() => onPrepareExecution(controlledExecutionSelection)}>{t.selectControlledTask}</button>
      </section>
      {status === "ready" && <section className="stats-strip" aria-label="Catalog statistics">
        {[
          [projects.length + (projectMore.hasMore ? "+" : ""), t.projects, "grid"],
          [tasks.length + (taskMore.hasMore ? "+" : ""), t.contracts, "file"],
          [2, t.supported, "chip"],
        ].map(([value, label, icon]) => (
          <div className="stat" key={String(label)}>
            <Icon name={String(icon)} size={20} />
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
        <div className="gate-inline">
          <Icon name="lock" size={16} />
          {t.gate}
        </div>
      </section>}
      <div className="workspace-grid">
        <section className="catalog-panel">
          <div className="section-heading">
            <h2>{t.catalogue}</h2>
            <button
              className="icon-button"
              aria-label={t.refresh}
              onClick={() => void loadCatalog()}
              disabled={status === "loading"}
            >
              <Icon name="refresh" size={17} />
            </button>
          </div>
          <div className="catalog-toolbar">
            <div className="search-field">
              <Icon name="search" size={16} />
              <input
                aria-label={t.search}
                placeholder={t.search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label={t.projects}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="all">{t.allProjects}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
          {status === "ready" && (projectMore.hasMore || projectMore.state === "error" || projectMore.loop || projectMore.capped) && (
            <div className="td-projects-more">
              {projectMore.hasMore && (
                <button className="secondary-button" onClick={() => void loadMoreProjects()} disabled={projectMore.state === "loading"}>
                  {projectMore.state === "loading" ? t.loadingMore : projectMore.state === "error" ? t.moreRetry + ": " + t.loadMoreProjects : t.loadMoreProjects}
                </button>
              )}
              {projectMore.state === "error" && <p className="td-error" role="alert">{t.moreError}</p>}
              {projectMore.loop && <p className="td-error" role="alert">{t.pagingLoop}</p>}
              {projectMore.capped && <p role="status">{t.catalogCapped}</p>}
            </div>
          )}
          <div className="td-toolbar">
            <select aria-label={t.statusFilter} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">{t.statusAll}</option>
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(t, s)}</option>)}
              <option value="unknown">{t.statusUnknown}</option>
            </select>
          </div>
          <div
            className="filter-tabs"
            role="group"
            aria-label="Task type"
          >
            {(["all", "lean", "software"] as const).map((k) => (
              <button
                className={type === k ? "selected" : ""}
                key={k}
                onClick={() => setType(k)}
              >
                {t[k]}
                {status === "ready" && <span>
                  {
                    tasks.filter((task) => k === "all" || task.type === k)
                      .length
                  }
                </span>}
              </button>
            ))}
          </div>
          {status === "unauthorized" ? (
            <div className="empty-state" role="alert"><p>{t.signInNeeded}</p><button className="secondary-button" onClick={() => setPage("account")}>{t.account}</button></div>
          ) : status === "error" ? (
            <div className="empty-state" role="alert">
              <p>{t.error}</p>
              <button
                className="secondary-button"
                onClick={() => void loadCatalog()}
              >
                {t.refresh}
              </button>
            </div>
          ) : status === "loading" ? (
            <div className="empty-state">{t.checking}…</div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">{source === "database" && tasks.length === 0 ? t.databaseEmpty : t.empty}</div>
          ) : (
            <div className="task-list">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  className={
                    "task-card " +
                    (task?.id === item.id ? "selected" : "")
                  }
                  onClick={() => setSelected(item.id)}
                  aria-pressed={task?.id === item.id}
                >
                  <div className="task-card-top">
                    <span className={"type-icon " + item.type}>
                      {item.type === "lean" ? (
                        "∑"
                      ) : (
                        <Icon name="code" size={20} />
                      )}
                    </span>
                    <span className="task-project">
                      {
                        projects.find((p) => p.id === item.project_id)
                          ?.title ?? item.project_id
                      }
                    </span>
                    <StatusBadge status={statusOf(statuses, item.id)} t={t} />
                    <span className="kind-badge">
                      {kindLabel(t, item.kind)}
                    </span>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  <div className="task-card-footer">
                    <span>
                      <Icon name="clock" size={14} />
                      {item.environment.time_limit_sec / 60} {t.min}
                    </span>
                    <span>
                      {item.parallelism.mode === "exclusive"
                        ? t.exclusive
                        : t.independent}
                    </span>
                    <span className="points">
                      {item.reward_points} {t.points}
                      <Icon name="arrow" size={15} />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
          {status === "ready" && (taskMore.hasMore || taskMore.state === "error" || taskMore.loop || taskMore.capped || duplicates > 0) && (
            <div className="td-pager">
              {taskMore.hasMore && (
                <button className="secondary-button" onClick={() => void loadMoreTasks()} disabled={taskMore.state === "loading"}>
                  {taskMore.state === "loading" ? t.loadingMore : taskMore.state === "error" ? t.moreRetry + ": " + t.loadMoreTasks : t.loadMoreTasks}
                </button>
              )}
              {taskMore.state === "error" && <p className="td-error" role="alert">{t.moreError}</p>}
              {taskMore.loop && <p className="td-error" role="alert">{t.pagingLoop}</p>}
              {taskMore.capped && <p role="status">{t.catalogCapped}</p>}
              {duplicates > 0 && <p role="status">{duplicates} {t.duplicatesIgnored}</p>}
            </div>
          )}
          {source && <p className="fixture-note">
            <Icon name="file" size={14} />
            {source === "database" ? t.databaseNote : t.example}
          </p>}
        </section>
        <aside className="detail-panel">
          {task ? (
            <>
              <div className="detail-kicker">
                <span>{t.selected}</span>
                <span>v{task.task_version}</span>
              </div>
              <h2 id="task-detail-heading" ref={detailHeading} tabIndex={-1}>{task.title}</h2>
              <div className="detail-facts">
                <span>{t.kindLabel}: <strong>{kindLabel(t, task.kind)}</strong></span>
                <span>{t.nodeLabel}: <code>{task.node_id}</code></span>
                <span title={t.statusNote}>{t.statusLabel}: <StatusBadge status={statusOf(statuses, task.id)} t={t} /></span>
              </div>
              <div className="detail-tabs">
                <button
                  className={tab === "overview" ? "selected" : ""}
                  onClick={() => setTab("overview")}
                >
                  {t.detail}
                </button>
                <button
                  className={tab === "contract" ? "selected" : ""}
                  onClick={() => setTab("contract")}
                >
                  {t.contract}
                </button>
              </div>
              {tab === "contract" ? (
                <pre
                  className="contract-json"
                  data-testid="contract-json"
                >
                  {JSON.stringify(task, null, 2)}
                </pre>
              ) : (
                <>
                  <p className="detail-description">{task.prompt}</p>
                  <label className="field-label" htmlFor="strategy">
                    {t.strategy}
                  </label>
                  <select
                    id="strategy"
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value)}
                  >
                    {task.strategies.map((s) => (
                      <option value={s.id} key={s.id}>
                        {s.id}
                      </option>
                    ))}
                  </select>
                  <p className="strategy-description">
                    {
                      task.strategies.find((s) => s.id === strategy)
                        ?.instructions
                    }
                  </p>
                  <div className="resource-grid">
                    <span>
                      CPU
                      <strong>
                        {Math.min(task.environment.cpu, settings.cpu)}{" "}
                        <small>core</small>
                      </strong>
                    </span>
                    <span>
                      RAM
                      <strong>
                        {Math.min(
                          task.environment.memory_mb,
                          settings.memoryMb,
                        ) / 1024}{" "}
                        <small>GB</small>
                      </strong>
                    </span>
                    <span>
                      {t.limit}
                      <strong>
                        {nativeMaxSec !== null
                          ? Math.floor(Math.min(task.environment.time_limit_sec, nativeMaxSec) / 60)
                          : Math.min(
                            task.environment.time_limit_sec / 60,
                            settings.taskMinutes,
                            settings.dailyMinutes,
                          )}{" "}
                        <small>{t.min}</small>
                      </strong>
                    </span>
                  </div>
                  <h4>{t.milestones}</h4>
                  <div className="milestone-list">
                    {task.progress.milestones.map((m) => (
                      <div key={m.id}>
                        <span className="milestone-circle" />
                        <span>
                          {m.name}
                          <small>{m.critical ? t.critical : ""}</small>
                        </span>
                        <strong>{Math.round(m.weight * 100)}%</strong>
                      </div>
                    ))}
                    {!task.progress.milestones.length && (
                      <p className="muted-note">{t.noMilestones}</p>
                    )}
                  </div>
                  <TaskDependenciesPanel task={task} tasks={tasks} visibleIds={visibleIds} statuses={statuses} hasMore={taskMore.hasMore} incomplete={taskMore.hasMore || taskMore.capped || taskMore.loop} loadingMore={taskMore.state === "loading"} t={t} onOpen={openRelation} onLoadMore={() => void loadMoreTasks()} />
                  <h4>{t.files}</h4>
                  <div className="file-manifest">
                    {task.workspace.entry_files.map((file) => (
                      <div key={file}>
                        <Icon name="file" size={14} />
                        <code>{file}</code>
                        <span>
                          {task.workspace.writable_paths.includes(file)
                            ? "rw"
                            : "r"}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <div className="contract-hash" title={task.contract_hash}>
                <Icon name="lock" size={12} />
                <span>sha256:{task.contract_hash.slice(0, 12)}…</span>
                <span>v{task.task_version}</span>
              </div>
              <div className="start-area">
                <button className="start-button" disabled>
                  <Icon name="lock" size={17} />
                  {t.start}
                </button>
                <strong>{t.gate}</strong>
                <p>{t.gateText}</p>
                <button
                  className="text-button"
                  disabled={!task.strategies.some(item => item.id === strategy)}
                  onClick={() => onPrepareExecution(captureCatalogSelection(task, strategy))}
                >
                  {t.prepareProfile}
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            </>
          ) : (
            <p className="empty-state">{t.noSelect}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
