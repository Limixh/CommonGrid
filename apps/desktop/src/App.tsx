import { useState } from "react";
import { AccountPanel } from "./AccountPanel";
import { useAccount } from "./account-api";
import { ContributionSettingsPage } from "./ContributionSettingsPage";
import { EnvironmentPage, useEnvironmentReadiness } from "./EnvironmentPage";
import { Icon } from "./Icon";
import { words } from "./language";
import { useContributionSettings } from "./settings";
import type { Page } from "./ui-types";
import { useTaskCatalog } from "./useTaskCatalog";
import { WorkspacePage } from "./WorkspacePage";
import { ManagedProfilesPanel } from "./ManagedProfilesPanel";

export function App() {
  const account = useAccount();
  const { settings, draft, setDraft, notice, setNotice, save, toggleLanguage } = useContributionSettings();
  const [page, setPage] = useState<Page>("workspace");
  const catalog = useTaskCatalog(account, settings.language);
  const { doctor, loadDoctor } = useEnvironmentReadiness();
  const { projects, tasks, status, source, project, setProject } = catalog;
  const t = words[settings.language];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="grid" size={23} />
          </span>
          <span>
            Common<span className="brand-light">Grid</span>
          </span>
        </div>
        <div className="sidebar-caption">{t.together}</div>
        <nav aria-label="Main navigation">
          {(["workspace", "agents", "settings", "account", "contributions"] as const).map((key, index) => (
            <button
              key={key}
              className={page === key ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(key);
                setNotice("");
              }}
            >
              <Icon name={["grid", "chip", "settings", "user", "file"][index]} />
              {t[key]}
              {key === "workspace" && status === "ready" && (
                <span className="nav-count">{tasks.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-projects">
          <div className="section-caption">{t.projects.toUpperCase()}</div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={
                "project-link " +
                (project === p.id && page === "workspace" ? "chosen" : "")
              }
              onClick={() => {
                setProject(p.id);
                setPage("workspace");
              }}
            >
              <span className={"project-dot " + p.type} />
              {p.title}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="phase-pill">
            <span className="dot" />
            {t.phase}
          </div>
          <div className="local-user">
            <span className="avatar">CG</span>
            <span>
              <strong>{account.state.status === "authenticated" ? account.state.session.user.display_name : t.local}</strong>
              <small>CommonGrid · v0.1.0</small>
            </span>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{t[page]}</span>
          <div className="connection">
            <span className={"status-dot " + status} />
            {status === "ready"
              ? t.connected
              : status === "loading"
                ? t.checking
                : status === "unauthorized" ? t.accountRequired : t.offline}
            <span className="separator" />
            <span className="source-label">{source === "database" ? t.database : source === "fixture" ? t.fixture : ""}</span>
          </div>
          <button
            className="language-switch"
            onClick={() => {
              toggleLanguage();
            }}
            aria-label="Change language"
          >
            <Icon name="globe" size={15} />
            {settings.language.toUpperCase()}
          </button>
        </header>
        {page === "workspace" ? (
          <WorkspacePage catalog={catalog} settings={settings} t={t} setPage={setPage} />
        ) : page === "agents" ? (
          <EnvironmentPage language={settings.language} doctor={doctor} loadDoctor={loadDoctor} managedProfiles={<ManagedProfilesPanel language={settings.language} />} />
        ) : page === "account" || page === "contributions" ? (
          <AccountPanel account={account} language={settings.language} contributions={page === "contributions"} />
        ) : (
          <ContributionSettingsPage draft={draft} setDraft={setDraft} notice={notice} setNotice={setNotice} save={save} t={t} />
        )}
        <footer className="main-footer">
          <span>CommonGrid</span>
          <span>Task contract / 1.0</span>
          <span className="footer-right">{t.phase}</span>
        </footer>
      </main>
    </div>
  );
}
