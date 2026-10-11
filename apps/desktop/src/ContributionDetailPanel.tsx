import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AccountExpired } from "./account-api";
import {
  ContributionHttpError, fetchContributionDetail, fetchResumeCheckpoint, resumeKey,
  type CheckpointDetail, type ContributionDetail, type DetailKind, type LeaseDetail, type ResumeTarget, type SubmissionDetail,
} from "./contribution-client";
import "./contribution-detail.css";

const words = {
  tr: {
    titles: { leases: "Deneme ayrıntıları", submissions: "Gönderim ayrıntıları", checkpoints: "Kayıtlı ilerleme ayrıntıları" },
    close: "Ayrıntıları kapat", loading: "Ayrıntılar yükleniyor…", retry: "Tekrar dene",
    missing: "Bu kayıt bulunamadı veya bu hesapta görüntülenemiyor.",
    unavailable: "Sunucu şu anda geçici olarak yanıt vermiyor. Biraz sonra tekrar dene.",
    error: "Kayıt ayrıntıları yüklenemedi. Tekrar dene.", unknown: "Bilinmiyor", none: "Yok", notYet: "Henüz yok",
    status: "Durum", task: "Görev", taskVersion: "Görev sürümü", contractHash: "Sözleşme hash'i", baseCommit: "Base commit",
    created: "Kayıt tarihi", started: "Başlangıç", stopRequested: "Durdurma isteği", ended: "Bitiş", expires: "Son kullanma",
    attemptId: "Deneme kimliği", strategy: "Strateji", leaseId: "Deneme", capacity: "Süre kapasitesi",
    capacityNote: "Bu değerler zamanlanmış çalışma süresi kapasitesidir; para, token veya abonelik kotası değildir.",
    limit: "Etkin süre sınırı", reserved: "Ayrılan süre", spent: "Kullanılan süre", overrun: "Aşım",
    verification: "Doğrulama durumu", verifiedAt: "Doğrulama zamanı", acceptedAt: "Kabul zamanı", notVerified: "Henüz doğrulanmadı",
    artifactId: "Artifact kimliği", artifactHash: "Artifact hash'i", artifactSize: "Artifact boyutu",
    submissionNote: "Bu yalnızca bir gönderim makbuzudur. Artifact içeriği veya diff buradan açılmaz ve kayıt bakımcı onayı anlamına gelmez.",
    summary: "Özet", instructions: "Devam talimatları", noSummary: "Özet kaydedilmemiş.", noInstructions: "Devam talimatı kaydedilmemiş.",
    type: "Tür", hard: "Çalışma alanı anlık görüntüsü", soft: "Açıklayıcı not", parent: "Önceki kayıt", firstCheckpoint: "Yok (ilk kayıt)",
    reason: "Red nedeni", expiredNote: "Son kullanma tarihi geçti. Süre dolması bu tarihten türetildi; sunucudaki durum yukarıda gösterilir.",
    untrusted: "Özet ve talimatlar kayıt sahibinin yazdığı düz metindir; doğrulanmış sonuç sayılmaz.",
    resumeTitle: "Uyumlu son kayıt kontrolü",
    resumeText: "Seçili görev ve stratejiyle sunucudan uyumlu son kayıtlı ilerlemeyi salt okunur sorgular. Bu işlem görevi başlatmaz veya devam ettirmez.",
    resumeSelected: "Kontrol edilen görev", resumeStrategy: "Seçili strateji",
    resumeNoTarget: "Kontrol için Çalışma alanında yüklenmiş bir görev ve onun stratejilerinden birini seç.",
    resumeOtherTask: "Bu kayıt başka bir göreve ait. Kontrol etmek için Çalışma alanında aynı görevi seç.",
    resumeCheck: "Uyumlu kaydı kontrol et", resumeChecking: "Sunucu kontrol ediliyor…",
    resumeFound: "Sunucu bu görev sürümü ve strateji için aşağıdaki kaydı uyumlu son kayıt olarak bildirdi.",
    resumeSame: "Bu, şu anda açık olan kayıtla aynı.", resumeDifferent: "Bu, şu anda açık olan kayıttan farklı bir kayıt.",
    resumeNone: "Sunucu bu görev sürümü ve strateji için uyumlu, kullanılabilir bir kayıtlı ilerleme bulamadı.",
    resumeStale: "Sunucuya göre görev sürümü veya sözleşmesi değişmiş. Görev kataloğunu yenile.",
    resumeClosed: "Sunucu bu görev için kayıttan devam etmeyi şu anda sunmuyor.",
    resumeUnavailable: "Sunucu şu anda geçici olarak yanıt vermiyor. Biraz sonra tekrar dene.",
    resumeError: "Kontrol tamamlanamadı. Tekrar dene.", resumeResult: "Sunucu cevabı",
    verifying: "Doğrulanıyor",
    reasons: { artifact_invalid: "Artifact geçersiz", unsafe_paths: "Güvenli olmayan dosya yolları", secret_detected: "Gizli bilgi bulundu", unsafe_text: "Güvenli olmayan metin", quick_check_failed: "Hızlı kontrol geçmedi", incompatible_base: "Base commit uyumsuz" },
    h: "sa", m: "dk", s: "sn", ms: "ms", bytes: "bayt",
  },
  en: {
    titles: { leases: "Attempt details", submissions: "Submission details", checkpoints: "Saved progress details" },
    close: "Close details", loading: "Loading details…", retry: "Try again",
    missing: "This record was not found or cannot be viewed with this account.",
    unavailable: "The server is temporarily not responding. Try again shortly.",
    error: "The record details could not load. Try again.", unknown: "Unknown", none: "None", notYet: "Not yet",
    status: "Status", task: "Task", taskVersion: "Task version", contractHash: "Contract hash", baseCommit: "Base commit",
    created: "Recorded on", started: "Started", stopRequested: "Stop requested", ended: "Ended", expires: "Expires",
    attemptId: "Attempt ID", strategy: "Strategy", leaseId: "Attempt", capacity: "Time capacity",
    capacityNote: "These values are scheduled run-time capacity, not money, tokens or a subscription quota.",
    limit: "Effective time limit", reserved: "Reserved time", spent: "Time used", overrun: "Overrun",
    verification: "Verification status", verifiedAt: "Verified at", acceptedAt: "Accepted at", notVerified: "Not verified yet",
    artifactId: "Artifact ID", artifactHash: "Artifact hash", artifactSize: "Artifact size",
    submissionNote: "This is only a submission receipt. Artifact contents or diffs cannot be opened here, and the record does not mean maintainer approval.",
    summary: "Summary", instructions: "Continuation instructions", noSummary: "No summary was recorded.", noInstructions: "No continuation instructions were recorded.",
    type: "Type", hard: "Workspace snapshot", soft: "Explanatory note", parent: "Parent", firstCheckpoint: "None (first checkpoint)",
    reason: "Rejection reason", expiredNote: "The expiry date has passed. Expiry is derived from this date; the server's status is shown above.",
    untrusted: "The summary and instructions are plain text written by the record's owner; they are not a verified result.",
    resumeTitle: "Compatible latest-record check",
    resumeText: "Asks the server, read-only, for the latest compatible saved progress for the selected task and strategy. This does not start or resume the task.",
    resumeSelected: "Task being checked", resumeStrategy: "Selected strategy",
    resumeNoTarget: "To check, select a loaded task and one of its strategies in the Workspace.",
    resumeOtherTask: "This record belongs to another task. Select that task in the Workspace to check it.",
    resumeCheck: "Check for a compatible record", resumeChecking: "Asking the server…",
    resumeFound: "The server reported the record below as the latest compatible record for this task version and strategy.",
    resumeSame: "It is the same as the record currently open.", resumeDifferent: "It is a different record from the one currently open.",
    resumeNone: "The server found no compatible, usable saved progress for this task version and strategy.",
    resumeStale: "The server reports that the task version or contract has changed. Refresh the task catalog.",
    resumeClosed: "The server is not offering resume from saved progress for this task right now.",
    resumeUnavailable: "The server is temporarily not responding. Try again shortly.",
    resumeError: "The check could not complete. Try again.", resumeResult: "Server response",
    verifying: "Verifying",
    reasons: { artifact_invalid: "Artifact is invalid", unsafe_paths: "Unsafe file paths", secret_detected: "Secret detected", unsafe_text: "Unsafe text", quick_check_failed: "Quick check failed", incompatible_base: "Base commit is incompatible" },
    h: "h", m: "min", s: "s", ms: "ms", bytes: "bytes",
  },
};
type Words = (typeof words)["tr"];
type Language = "tr" | "en";
type Props = {
  kind: DetailKind; recordID: string; language: Language; statusLabel: (state: string) => string;
  resumeTarget: ResumeTarget | null; onClose: () => void; onExpired: () => void;
};
type Load = { status: "loading" | "missing" | "unavailable" | "error" } | { status: "ready"; detail: ContributionDetail };

function when(value: string | undefined, language: Language, fallback: string) { return value ? new Date(value).toLocaleString(language) : fallback; }
function duration(ms: number, t: Words) {
  if (ms < 1000) return `${ms} ${t.ms}`;
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  return [hours ? `${hours} ${t.h}` : "", minutes ? `${minutes} ${t.m}` : "", seconds || (!hours && !minutes) ? `${seconds} ${t.s}` : ""].filter(Boolean).join(" ");
}
function Row({ label, children }: { label: string; children: ReactNode }) { return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>; }

function LeaseView({ record, t, language, statusLabel }: { record: LeaseDetail; t: Words; language: Language; statusLabel: (s: string) => string }) {
  return <>
    <dl className="detail-fields">
      <Row label={t.status}>{statusLabel(record.state)}</Row>
      <Row label={t.task}>{record.taskId}</Row>
      <Row label={t.strategy}>{record.strategyId}</Row>
      <Row label={t.taskVersion}>{record.taskVersion}</Row>
      <Row label={t.contractHash}><code>{record.contractHash}</code></Row>
      <Row label={t.attemptId}><code>{record.attemptId}</code></Row>
      <Row label={t.created}>{when(record.createdAt, language, t.unknown)}</Row>
      <Row label={t.started}>{when(record.startedAt, language, t.notYet)}</Row>
      <Row label={t.stopRequested}>{when(record.stopRequestedAt, language, t.none)}</Row>
      <Row label={t.ended}>{when(record.endedAt, language, t.notYet)}</Row>
      <Row label={t.expires}>{when(record.expiresAt, language, t.unknown)}</Row>
    </dl>
    <h3>{t.capacity}</h3>
    <dl className="detail-fields">
      <Row label={t.limit}>{duration(record.effectiveLimitSec * 1000, t)}</Row>
      <Row label={t.reserved}>{duration(record.reservedMs, t)}</Row>
      <Row label={t.spent}>{duration(record.spentMs, t)}</Row>
      <Row label={t.overrun}>{duration(record.overrunMs, t)}</Row>
    </dl>
    <p className="muted-note">{t.capacityNote}</p>
  </>;
}
function SubmissionView({ record, t, language, statusLabel }: { record: SubmissionDetail; t: Words; language: Language; statusLabel: (s: string) => string }) {
  return <>
    <dl className="detail-fields">
      <Row label={t.verification}>{statusLabel(record.status)}</Row>
      <Row label={t.verifiedAt}>{when(record.verifiedAt, language, t.notVerified)}</Row>
      <Row label={t.acceptedAt}>{when(record.acceptedAt, language, t.notYet)}</Row>
      <Row label={t.task}>{record.taskId}</Row>
      <Row label={t.taskVersion}>{record.taskVersion}</Row>
      <Row label={t.contractHash}><code>{record.contractHash}</code></Row>
      <Row label={t.baseCommit}><code>{record.baseCommit}</code></Row>
      <Row label={t.leaseId}><code>{record.leaseId}</code></Row>
      <Row label={t.artifactId}><code>{record.artifactId}</code></Row>
      <Row label={t.artifactHash}><code>{record.artifactSha256}</code></Row>
      <Row label={t.artifactSize}>{record.artifactSize.toLocaleString(language)} {t.bytes}</Row>
      <Row label={t.created}>{when(record.createdAt, language, t.unknown)}</Row>
    </dl>
    <p className="muted-note">{t.submissionNote}</p>
  </>;
}
function CheckpointView({ record, t, language, statusLabel }: { record: CheckpointDetail; t: Words; language: Language; statusLabel: (s: string) => string }) {
  const expired = Date.parse(record.expiresAt) <= Date.now();
  const decided = record.status === "usable" || record.status === "rejected";
  const reason = record.status !== "rejected" ? null : record.reasonCode && record.reasonCode in t.reasons ? t.reasons[record.reasonCode as keyof typeof t.reasons] : t.unknown;
  return <>
    <dl className="detail-fields">
      <Row label={t.verification}>{record.status === "verifying" ? t.verifying : statusLabel(record.status)}</Row>
      {reason !== null && <Row label={t.reason}>{reason}</Row>}
      <Row label={t.verifiedAt}>{when(record.verifiedAt, language, decided ? t.unknown : t.notVerified)}</Row>
      <Row label={t.expires}>{when(record.expiresAt, language, t.unknown)}</Row>
      <Row label={t.type}>{t[record.type]}</Row>
      <Row label={t.task}>{record.taskId}</Row>
      <Row label={t.taskVersion}>{record.taskVersion}</Row>
      <Row label={t.contractHash}><code>{record.contractHash}</code></Row>
      <Row label={t.baseCommit}><code>{record.baseCommit}</code></Row>
      <Row label={t.parent}>{record.parentId ? <code>{record.parentId}</code> : t.firstCheckpoint}</Row>
      <Row label={t.leaseId}><code>{record.leaseId}</code></Row>
      <Row label={t.artifactId}><code>{record.artifactId}</code></Row>
      <Row label={t.artifactHash}><code>{record.artifactSha256}</code></Row>
      <Row label={t.artifactSize}>{record.artifactSize.toLocaleString(language)} {t.bytes}</Row>
      <Row label={t.created}>{when(record.createdAt, language, t.unknown)}</Row>
    </dl>
    {expired && <p className="detail-expired" data-testid="checkpoint-expired">{t.expiredNote}</p>}
    <h3>{t.summary}</h3>
    {record.summary ? <pre className="detail-text" data-testid="checkpoint-summary">{record.summary}</pre> : <p className="muted-note">{t.noSummary}</p>}
    <h3>{t.instructions}</h3>
    {record.continuation ? <pre className="detail-text" data-testid="checkpoint-instructions">{record.continuation}</pre> : <p className="muted-note">{t.noInstructions}</p>}
    <p className="muted-note">{t.untrusted}</p>
  </>;
}

type Resume = { key: string; status: "loading" | "found" | "none" | "stale" | "closed" | "unavailable" | "error"; record?: CheckpointDetail };
function ResumeCheck({ opened, target, t, language, statusLabel, onExpired }: { opened: CheckpointDetail; target: ResumeTarget | null; t: Words; language: Language; statusLabel: (s: string) => string; onExpired: () => void }) {
  const [result, setResult] = useState<Resume | null>(null);
  const active = useRef<AbortController | null>(null);
  const key = target ? resumeKey(target) : "";
  const known = target?.task.strategies.some((strategy) => strategy.id === target.strategyId) ?? false;
  // Any change of task, version, hash, base commit or strategy discards a prior answer.
  useEffect(() => { setResult(null); return () => { active.current?.abort(); active.current = null; }; }, [key]);
  const visible = result && result.key === key ? result : null;
  async function check() {
    if (!target || !known) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    const request = key;
    const finish = (next: Resume) => { if (active.current === controller) setResult(next); };
    setResult({ key: request, status: "loading" });
    try {
      const record = await fetchResumeCheckpoint(target, controller.signal);
      finish({ key: request, status: "found", record });
    } catch (error) {
      if (active.current !== controller) return;
      if (error instanceof AccountExpired) { onExpired(); return; }
      if (error instanceof ContributionHttpError) {
        if (error.status === 404) finish({ key: request, status: "none" });
        else if (error.status === 409) finish({ key: request, status: error.code === "stale_contract" ? "stale" : "closed" });
        else if (error.status === 503) finish({ key: request, status: "unavailable" });
        else finish({ key: request, status: "error" });
      } else finish({ key: request, status: "error" });
    } finally { window.clearTimeout(timeout); }
  }
  const otherTask = target !== null && target.task.id !== opened.taskId;
  const messages = { none: t.resumeNone, stale: t.resumeStale, closed: t.resumeClosed, unavailable: t.resumeUnavailable, error: t.resumeError };
  return <section className="resume-check" aria-labelledby="resume-check-title">
    <h3 id="resume-check-title">{t.resumeTitle}</h3>
    <p className="muted-note">{t.resumeText}</p>
    {!target || !known ? <p className="muted-note" role="status">{t.resumeNoTarget}</p> : <>
      <dl className="detail-fields">
        <Row label={t.resumeSelected}>{target.task.title}</Row>
        <Row label={t.taskVersion}>{target.task.task_version}</Row>
        <Row label={t.contractHash}><code>{target.task.contract_hash}</code></Row>
        <Row label={t.baseCommit}><code>{target.task.workspace.commit}</code></Row>
        <Row label={t.resumeStrategy}>{target.strategyId}</Row>
      </dl>
      {otherTask ? <p className="muted-note" role="status">{t.resumeOtherTask}</p>
        : <button className="secondary-button" onClick={() => void check()} disabled={visible?.status === "loading"}>{visible?.status === "loading" ? t.resumeChecking : t.resumeCheck}</button>}
    </>}
    {visible && visible.status !== "loading" && <div className="resume-result" role="status" aria-label={t.resumeResult}>
      {visible.status === "found" && visible.record ? <>
        <p>{t.resumeFound}</p>
        <p className="muted-note">{visible.record.id === opened.id ? t.resumeSame : t.resumeDifferent}</p>
        <div data-testid="resume-record"><CheckpointView record={visible.record} t={t} language={language} statusLabel={statusLabel} /></div>
      </> : <p>{messages[visible.status as keyof typeof messages]}</p>}
      {(visible.status === "unavailable" || visible.status === "error") && <button className="secondary-button" onClick={() => void check()}>{t.retry}</button>}
    </div>}
  </section>;
}

export function ContributionDetailPanel({ kind, recordID, language, statusLabel, resumeTarget, onClose, onExpired }: Props) {
  const t = words[language];
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const panel = useRef<HTMLElement | null>(null);
  // The parent mounts this panel with a key made of account, section and record,
  // so a previous record's answer can never be rendered here. The controller
  // check additionally drops answers from superseded or retried requests.
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    let stale = false;
    setLoad({ status: "loading" });
    fetchContributionDetail(kind, recordID, controller.signal).then((detail) => {
      if (!stale) setLoad({ status: "ready", detail });
    }, (error: unknown) => {
      if (stale) return;
      if (error instanceof AccountExpired) onExpired();
      else if (error instanceof ContributionHttpError && error.status === 404) setLoad({ status: "missing" });
      else if (error instanceof ContributionHttpError && error.status === 503) setLoad({ status: "unavailable" });
      else setLoad({ status: "error" });
    }).finally(() => window.clearTimeout(timeout));
    return () => { stale = true; controller.abort(); window.clearTimeout(timeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, recordID, retry]);
  useEffect(() => { panel.current?.focus(); }, []);
  function keyDown(event: KeyboardEvent) { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }
  const detail = load.status === "ready" ? load.detail : null;
  return <section ref={panel} id="contribution-detail" className="contribution-detail" tabIndex={-1} aria-labelledby="contribution-detail-title" onKeyDown={keyDown}>
    <div className="detail-header">
      <h2 id="contribution-detail-title">{t.titles[kind]}</h2>
      <button className="secondary-button" onClick={onClose}>{t.close}</button>
    </div>
    {load.status === "loading" ? <div role="status" className="detail-state">{t.loading}</div>
      : load.status === "ready" ? null
      : <div role="alert" className="detail-state">
        <p>{load.status === "missing" ? t.missing : load.status === "unavailable" ? t.unavailable : t.error}</p>
        {load.status !== "missing" && <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>{t.retry}</button>}
      </div>}
    {detail?.kind === "leases" && <LeaseView record={detail.record} t={t} language={language} statusLabel={statusLabel} />}
    {detail?.kind === "submissions" && <SubmissionView record={detail.record} t={t} language={language} statusLabel={statusLabel} />}
    {detail?.kind === "checkpoints" && <>
      <CheckpointView record={detail.record} t={t} language={language} statusLabel={statusLabel} />
      <ResumeCheck opened={detail.record} target={resumeTarget} t={t} language={language} statusLabel={statusLabel} onExpired={onExpired} />
    </>}
  </section>;
}
