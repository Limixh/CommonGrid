import { useEffect, useMemo, useRef, useState } from "react";
import { validateTask, type TaskContract } from "@commongrid/task-schema";
import { AccountPanel } from "./AccountPanel";
import { OperationRecoveryPanel } from "./OperationRecoveryPanel";
import { CliCheckPanel } from "./CliCheckPanel";
import { boundedText, useAccount } from "./account-api";

type Project = { id: string; title: string; type: string; description: string };
type Check = {
  id: string;
  label: string;
  state: "available" | "missing" | "not_running";
  version: string | null;
};
type Doctor = { checked_at: string; checks: Check[]; isolation_gate: string };
type Settings = {
  language: "tr" | "en";
  cpu: number;
  memoryMb: number;
  taskMinutes: number;
  dailyMinutes: number;
  concurrency: number;
};
const defaults: Settings = {
  language: "tr",
  cpu: 2,
  memoryMb: 4096,
  taskMinutes: 30,
  dailyMinutes: 120,
  concurrency: 1,
};
function settingsValid(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  const s = value as Settings;
  return (
    ["tr", "en"].includes(s.language) &&
    Object.entries({
      cpu: [1, 64],
      memoryMb: [256, 262144],
      taskMinutes: [1, 1440],
      dailyMinutes: [1, 1440],
      concurrency: [1, 8],
    }).every(
      ([key, [min, max]]) =>
        Number.isInteger(s[key as keyof Settings]) &&
        Number(s[key as keyof Settings]) >= min &&
        Number(s[key as keyof Settings]) <= max,
    ) &&
    s.taskMinutes <= s.dailyMinutes
  );
}
function loadSettings() {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem("commongrid.settings.v1") ?? "null",
    );
    return settingsValid(stored) ? stored : defaults;
  } catch {
    return defaults;
  }
}
const words = {
  tr: {
    workspace: "Çalışma alanı",
    agents: "Ajanlar ve ortam",
    settings: "Katkı ayarları",
    account: "Hesabım",
    contributions: "Katkılarım",
    database: "Ortak görev kataloğu",
    signInNeeded: "Görevleri görmek için hesabına giriş yap.",
    accountRequired: "Giriş gerekli",
    databaseEmpty: "Henüz paylaşılmış bir görev yok.",
    databaseNote: "Ortak görevleri inceleyebilirsin. Görev başlatma henüz kullanıma hazır değil.",
    together: "BİRLİKTE ÇÖZ",
    phase: "FAZ 0 · GELİŞTİRME",
    connected: "Koordinatör bağlı",
    offline: "Koordinatör bağlantısı yok",
    checking: "Bağlanıyor",
    fixture: "Örnek görev kataloğu",
    eyebrow: "ORTAK PROBLEMLER, ORTAK İLERLEME",
    hero: "Bir problemin",
    hero2: "parçası ol.",
    subtitle:
      "Bir alt hedef seç. Kendi ajanını bağla. Doğrulanabilir bir çözüme katkıda bulun.",
    projects: "Proje",
    contracts: "Görev sözleşmesi",
    supported: "Hedef ajan",
    catalogue: "Görevleri keşfet",
    search: "Görevlerde ara…",
    all: "Tümü",
    lean: "Matematik",
    software: "Yazılım",
    allProjects: "Tüm projeler",
    refresh: "Yenile",
    empty: "Bu filtrelerle eşleşen görev bulunamadı.",
    error:
      "Görevler yüklenemedi. Bağlantını kontrol edip tekrar dene.",
    task: "GÖREV",
    mode: "ÇALIŞMA MODU",
    limit: "SÜRE LİMİTİ",
    independent: "Bağımsız",
    exclusive: "Tek deneme",
    min: "dk",
    detail: "Görev özeti",
    contract: "Sözleşme",
    selected: "SEÇİLEN GÖREV",
    strategy: "Onaylı yaklaşım",
    milestones: "Doğrulama hedefleri",
    base: "Çalışma alanı",
    start: "Görevi başlat",
    gate: "İzolasyon doğrulaması bekleniyor",
    gateText:
      "Gerçek hesapla çalıştırma, CLI kimliği ile görev kodunun ayrıldığı doğrulanınca açılacak.",
    inspect: "Ortamı incele",
    example:
      "Bu katalog geliştirme örnekleri içerir. Depo ve imajlar çalıştırma için hazır değildir.",
    ready: "Kurulu",
    missing: "Bulunamadı",
    stopped: "Motor çalışmıyor",
    doctorTitle: "Çalıştırma ortamın",
    doctorText:
      "CLI sürümleri ve geliştirme araçları yerel olarak kontrol edilir. Hesap giriş bilgileri okunmaz.",
    noReport:
      "Ortam raporu henüz oluşturulmadı. Terminalde npm run doctor çalıştırın.",
    reportDate: "Son kontrol",
    reportRefresh: "Raporu yenile",
    notEvaluated: "Henüz değerlendirilmedi",
    identity: "Kimlik izolasyonu kapısı",
    nextTitle: "Bir sonraki doğrulama",
    nextText:
      "Resmi CLI, görev araçlarından ayrı kimlikle çalışmalı. Dosya, süreç, ağ ve token yenileme denemeleri geçmeden görev başlatma açılmaz.",
    settingsTitle: "Katkının sınırlarını belirle",
    settingsText:
      "Tercihler bu cihazda saklanır. Çalıştırıcı hazır olduğunda etkin limit, görev ile senin sınırlarının en küçüğü olacak.",
    resources: "Kaynak sınırları",
    budget: "Zaman bütçesi",
    cpu: "CPU çekirdeği",
    memory: "Bellek (MB)",
    taskTime: "Tek deneme (dakika)",
    dailyTime: "Günlük aktif süre (dakika)",
    concurrency: "Eşzamanlı deneme",
    language: "Arayüz dili",
    save: "Tercihleri kaydet",
    saved: "Tercihler bu cihazda kaydedildi.",
    invalid: "Geçerli tam sayılar girin; tek deneme günlük bütçeyi aşamaz.",
    paid: "Ücretli API kullanımı kapalı",
    paidText:
      "Abonelik kotası dolduğunda otomatik ücretli kullanıma geçiş yapılmaz.",
    local: "Yerel geliştirme",
    noSelect: "Bir görev seçerek sözleşmesini incele.",
    files: "DOSYA MANİFESTİ",
    points: "puan",
    human: "İnceleme gerekli",
    plan: "AYRIŞTIRMA",
    solve: "ÇÖZÜM",
    critical: "zorunlu",
    noMilestones:
      "Plan önerisi bağlantı ispatı ve insan incelemesiyle değerlendirilecek.",
  },
  en: {
    workspace: "Workspace",
    agents: "Agents & environment",
    settings: "Contribution settings",
    account: "My account",
    contributions: "My contributions",
    database: "Shared task catalog",
    signInNeeded: "Sign in to see the tasks.",
    accountRequired: "Sign-in required",
    databaseEmpty: "No tasks have been shared yet.",
    databaseNote: "Explore the shared tasks. Task execution is still being prepared.",
    together: "SOLVE TOGETHER",
    phase: "PHASE 0 · DEVELOPMENT",
    connected: "Coordinator connected",
    offline: "Coordinator offline",
    checking: "Connecting",
    fixture: "Example task catalog",
    eyebrow: "SHARED PROBLEMS, SHARED PROGRESS",
    hero: "Be part of",
    hero2: "the solution.",
    subtitle:
      "Choose a subgoal. Connect your own agent. Contribute a verifiable result.",
    projects: "Projects",
    contracts: "Task contracts",
    supported: "Target agents",
    catalogue: "Explore tasks",
    search: "Search tasks…",
    all: "All",
    lean: "Mathematics",
    software: "Software",
    allProjects: "All projects",
    refresh: "Refresh",
    empty: "No tasks match these filters.",
    error:
      "Tasks could not load. Check your connection and try again.",
    task: "TASK",
    mode: "EXECUTION MODE",
    limit: "TIME LIMIT",
    independent: "Independent",
    exclusive: "Single attempt",
    min: "min",
    detail: "Task overview",
    contract: "Contract",
    selected: "SELECTED TASK",
    strategy: "Approved strategy",
    milestones: "Verification goals",
    base: "Workspace",
    start: "Start task",
    gate: "Isolation verification pending",
    gateText:
      "Real accounts can run after CLI credentials are proven separate from task code.",
    inspect: "Inspect environment",
    example:
      "This catalog contains development fixtures. Repositories and images are not ready to execute.",
    ready: "Installed",
    missing: "Not found",
    stopped: "Engine stopped",
    doctorTitle: "Your execution environment",
    doctorText:
      "CLI versions and development tools are checked locally. Account credentials are never read.",
    noReport: "No environment report yet. Run npm run doctor in your terminal.",
    reportDate: "Last checked",
    reportRefresh: "Reload report",
    notEvaluated: "Not evaluated",
    identity: "Credential isolation gate",
    nextTitle: "Next verification",
    nextText:
      "The official CLI must run under a separate identity from task tools. File, process, network and token renewal checks must pass before execution is enabled.",
    settingsTitle: "Set your contribution limits",
    settingsText:
      "Preferences are stored on this device. When execution is ready, effective limits will be the minimum of your settings and the task limits.",
    resources: "Resource limits",
    budget: "Time budget",
    cpu: "CPU cores",
    memory: "Memory (MB)",
    taskTime: "Per attempt (minutes)",
    dailyTime: "Daily active time (minutes)",
    concurrency: "Concurrent attempts",
    language: "Interface language",
    save: "Save preferences",
    saved: "Preferences saved on this device.",
    invalid:
      "Enter valid whole numbers; attempt time cannot exceed the daily budget.",
    paid: "Paid API usage disabled",
    paidText:
      "Reaching a subscription quota never automatically switches to paid usage.",
    local: "Local development",
    noSelect: "Select a task to inspect its contract.",
    files: "FILE MANIFEST",
    points: "points",
    human: "Review required",
    plan: "DECOMPOSITION",
    solve: "SOLUTION",
    critical: "required",
    noMilestones: "The proposal needs a connection proof and human review.",
  },
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    chip: "M7 7h10v10H7z M9 1v6m6-6v6M9 17v6m6-6v6M1 9h6m-6 6h6m10-6h6m-6 6h6",
    settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
    refresh: "M20 7A9 9 0 1 0 21 14M20 2v5h-5",
    lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
    code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
    check: "m5 12 4 4L19 6",
    file: "M5 2h9l5 5v15H5zM14 2v5h5",
    clock: "M12 8v5l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20",
    globe:
      "M2 12h20M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 2c-6 6-6 14 0 20 6-6 6-14 0-20",
    user: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-3a8 8 0 0 1 16 0v3",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.grid} />
    </svg>
  );
}
export function App() {
  const account = useAccount();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [draft, setDraft] = useState<Settings>(settings);
  const [page, setPage] = useState<"workspace" | "agents" | "settings" | "account" | "contributions">(
    "workspace",
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<TaskContract[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "unauthorized">(
    "loading",
  );
  const [source, setSource] = useState<"fixture" | "database" | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [project, setProject] = useState("all");
  const [tab, setTab] = useState<"overview" | "contract">("overview");
  const [strategy, setStrategy] = useState("");
  const [notice, setNotice] = useState("");
  const t = words[settings.language];
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
  async function loadDoctor() {
    try {
      const res = await fetch("/local-readiness");
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (!Array.isArray(data.checks)) throw new Error();
      setDoctor(data);
    } catch {
      setDoctor(null);
    }
  }
  useEffect(() => {
    void loadDoctor();
  }, []);
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
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (type === "all" || task.type === type) &&
          (project === "all" || task.project_id === project) &&
          (task.title + " " + task.description)
            .toLocaleLowerCase(settings.language)
            .includes(query.toLocaleLowerCase(settings.language)),
      ),
    [tasks, type, project, query, settings.language],
  );
  const task = filtered.find((item) => item.id === selected) ?? filtered[0];
  useEffect(() => {
    setStrategy(task?.strategies[0]?.id ?? "");
    setTab("overview");
  }, [task?.id]);
  function save() {
    if (!settingsValid(draft)) {
      setNotice("invalid");
      return;
    }
    try {
      localStorage.setItem("commongrid.settings.v1", JSON.stringify(draft));
      setSettings(draft);
      setNotice("saved");
    } catch {
      setNotice("storage");
    }
  }
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
              const next = {
                ...settings,
                language: settings.language === "tr" ? "en" : "tr",
              } as Settings;
              setDraft(next);
              setSettings(next);
              try {
                localStorage.setItem(
                  "commongrid.settings.v1",
                  JSON.stringify(next),
                );
              } catch {
                /* Session language still changes. */
              }
            }}
            aria-label="Change language"
          >
            <Icon name="globe" size={15} />
            {settings.language.toUpperCase()}
          </button>
        </header>
        {page === "workspace" ? (
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
            {status === "ready" && <section className="stats-strip" aria-label="Catalog statistics">
              {[
                [projects.length, t.projects, "grid"],
                [tasks.length, t.contracts, "file"],
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
                                ?.title
                            }
                          </span>
                          <span className="kind-badge">
                            {item.kind === "plan" ? t.plan : t.solve}
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
                    <h2>{task.title}</h2>
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
                              {Math.min(
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
                        onClick={() => setPage("agents")}
                      >
                        {t.inspect}
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
        ) : page === "agents" ? (
          <div className="settings-content">
            <div className="eyebrow">{t.phase}</div>
            <h1>{t.doctorTitle}</h1>
            <p className="page-description">{t.doctorText}</p>
            <div className="section-heading">
              <h2>{t.agents}</h2>
              <button
                className="secondary-button"
                onClick={() => void loadDoctor()}
              >
                <Icon name="refresh" size={15} />
                {t.reportRefresh}
              </button>
            </div>
            {doctor ? (
              <>
                <div className="agent-grid">
                  {doctor.checks.map((check) => (
                    <article className="agent-card" key={check.id}>
                      <span className="agent-symbol">
                        <Icon
                          name={
                            ["codex", "claude"].includes(check.id)
                              ? "chip"
                              : "code"
                          }
                          size={25}
                        />
                      </span>
                      <div>
                        <h3>{check.label}</h3>
                        <code>{check.version ?? "—"}</code>
                      </div>
                      <span className={"check-state " + check.state}>
                        {check.state === "available"
                          ? t.ready
                          : check.state === "not_running"
                            ? t.stopped
                            : t.missing}
                      </span>
                    </article>
                  ))}
                </div>
                <p className="muted-note">
                  {t.reportDate}:{" "}
                  {new Date(doctor.checked_at).toLocaleString(
                    settings.language,
                  )}
                </p>
              </>
            ) : (
              <div className="empty-state">{t.noReport}</div>
            )}
            <CliCheckPanel language={settings.language} />
            <div className="isolation-card">
              <Icon name="lock" size={26} />
              <div>
                <span className="eyebrow">{t.identity}</span>
                <h2>{t.notEvaluated}</h2>
                <p>{t.nextText}</p>
                <code>npm run doctor</code>
              </div>
            </div>
            <OperationRecoveryPanel language={settings.language} />
          </div>
        ) : page === "account" || page === "contributions" ? (
          <AccountPanel account={account} language={settings.language} contributions={page === "contributions"} />
        ) : (
          <div className="settings-content">
            <div className="eyebrow">{t.local}</div>
            <h1>{t.settingsTitle}</h1>
            <p className="page-description">{t.settingsText}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <div className="settings-box">
                <h2>{t.resources}</h2>
                <div className="form-grid">
                  {(["cpu", "memoryMb", "concurrency"] as const).map(
                    (key, i) => (
                      <label key={key}>
                        {[t.cpu, t.memory, t.concurrency][i]}
                        <input
                          type="number"
                          step="1"
                          min={key === "memoryMb" ? 256 : 1}
                          max={
                            key === "cpu" ? 64 : key === "memoryMb" ? 262144 : 8
                          }
                          value={Number.isFinite(draft[key]) ? draft[key] : ""}
                          onChange={(e) => {
                            setDraft({
                              ...draft,
                              [key]: e.target.valueAsNumber,
                            });
                            setNotice("");
                          }}
                          required
                        />
                      </label>
                    ),
                  )}
                </div>
              </div>
              <div className="settings-box">
                <h2>{t.budget}</h2>
                <div className="form-grid">
                  <label>
                    {t.taskTime}
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      step="1"
                      value={
                        Number.isFinite(draft.taskMinutes)
                          ? draft.taskMinutes
                          : ""
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          taskMinutes: e.target.valueAsNumber,
                        })
                      }
                      required
                    />
                  </label>
                  <label>
                    {t.dailyTime}
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      step="1"
                      value={
                        Number.isFinite(draft.dailyMinutes)
                          ? draft.dailyMinutes
                          : ""
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          dailyMinutes: e.target.valueAsNumber,
                        })
                      }
                      required
                    />
                  </label>
                  <label>
                    {t.language}
                    <select
                      value={draft.language}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          language: e.target.value as "tr" | "en",
                        })
                      }
                    >
                      <option value="tr">Türkçe</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="paid-note">
                <Icon name="lock" size={20} />
                <div>
                  <strong>{t.paid}</strong>
                  <p>{t.paidText}</p>
                </div>
              </div>
              <div className="save-row">
                <button type="submit" className="primary-button">
                  <Icon name="check" size={17} />
                  {t.save}
                </button>
                {notice && (
                  <span
                    role="status"
                    className={
                      notice === "saved" ? "saved-message" : "error-message"
                    }
                  >
                    {notice === "storage"
                      ? "Local storage unavailable"
                      : t[notice as "saved" | "invalid"]}
                  </span>
                )}
              </div>
            </form>
          </div>
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
