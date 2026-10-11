import type { TaskContract } from "@commongrid/task-schema";
import type { UIWords } from "./language";
import { kindLabel, relationsOf, statusLabel, type Relation, type StatusKey, type StatusMap } from "./task-dependencies";
import "./task-dependencies.css";

export function StatusBadge({ status, t }: { status: StatusKey; t: UIWords }) {
  return <span className={"td-status td-status-" + status} data-status={status}>{statusLabel(t, status)}</span>;
}

type PanelProps = {
  task: TaskContract;
  tasks: readonly TaskContract[];
  visibleIds: ReadonlySet<string>;
  statuses: StatusMap;
  hasMore: boolean;
  incomplete: boolean;
  loadingMore: boolean;
  t: UIWords;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
};

export function TaskDependenciesPanel({ task, tasks, visibleIds, statuses, hasMore, incomplete, loadingMore, t, onOpen, onLoadMore }: PanelProps) {
  const relations = relationsOf(task, tasks, visibleIds, statuses, incomplete);
  const stateLabel = { visible: t.relVisible, filtered: t.relFiltered, unloaded: t.relUnloaded, absent: t.relAbsent } as const;
  const hint = { visible: "", filtered: t.relFilteredHint, unloaded: t.relUnloadedHint, absent: t.relAbsentHint } as const;
  function item(relation: Relation) {
    const title = relation.task?.title ?? relation.id;
    return (
      <li key={relation.id} className={"td-item td-" + relation.state} data-relation-state={relation.state}>
        <div className="td-item-head">
          <span className="td-title">{title}</span>
          <StatusBadge status={relation.status} t={t} />
        </div>
        <div className="td-meta">
          <code>{relation.id}</code>
          {relation.task && <span>{kindLabel(t, relation.task.kind)}</span>}
          <span className="td-state">{stateLabel[relation.state]}</span>
        </div>
        {hint[relation.state] && <p className="td-hint">{hint[relation.state]}</p>}
        {relation.task && (
          <button className="td-open" onClick={() => onOpen(relation.id)} aria-label={`${relation.state === "visible" ? t.relOpen : t.relReveal}: ${title}`}>
            {relation.state === "visible" ? t.relOpen : t.relReveal}
          </button>
        )}
      </li>
    );
  }
  return (
    <section className="td-panel" aria-labelledby="td-heading" data-testid="task-dependencies">
      <h4 id="td-heading">{t.depTitle}</h4>
      <p className="td-note">{t.depNote}</p>
      <h5 id="td-prereq-heading">{t.prerequisites} <span>({relations.prerequisites.length})</span></h5>
      {relations.prerequisites.length ? <ul aria-labelledby="td-prereq-heading" className="td-list">{relations.prerequisites.map(item)}</ul> : <p className="td-empty">{t.noPrerequisites}</p>}
      <h5 id="td-dependents-heading">{t.dependents} <span>({relations.dependents.length + relations.hiddenDependents})</span></h5>
      {relations.dependents.length ? <ul aria-labelledby="td-dependents-heading" className="td-list">{relations.dependents.map(item)}</ul> : <p className="td-empty">{t.noDependents}</p>}
      {relations.hiddenDependents > 0 && <p className="td-hint">{relations.hiddenDependents} {t.moreRelations}</p>}
      {!relations.dependentsComplete && <p className="td-hint" role="note">{t.dependentsPartial}</p>}
      {hasMore && (
        <button className="secondary-button td-more" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? t.loadingMore : t.relLoadMore}
        </button>
      )}
    </section>
  );
}
