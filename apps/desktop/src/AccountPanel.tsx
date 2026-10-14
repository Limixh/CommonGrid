import { useEffect, useRef, useState } from "react";
import { AccountExpired, accountJSON, boundedText, type Account } from "./account-api";
import { ContributionDetailPanel } from "./ContributionDetailPanel";
import type { ResumeTarget } from "./contribution-client";

const words = {
  tr: {
    account: "Hesabım", contributions: "Katkılarım", description: "Hesabını bağlayarak sana ait katkı kayıtlarını görüntüle.",
    privacy: "Hesap bağlantısı tek başına görev başlatmaz. Desteklenen görevler ayrıca profil seçimi ve açık çalıştırma onayı gerektirir.",
    loading: "Hesap kontrol ediliyor…", offline: "Hesap bilgilerine ulaşılamadı. Bağlantını kontrol edip tekrar dene.",
    retry: "Tekrar dene", signIn: "Giriş yap", github: "GitHub ile giriş yap", google: "Google ile giriş yap",
    preparing: "Hesap bağlantısı hazırlanıyor", preparingText: "Giriş seçenekleri hazır olduğunda burada görünecek.",
    providerError: "Giriş seçenekleri yüklenemedi.", signedIn: "Bağlı hesap", logout: "Çıkış yap", loggingOut: "Çıkış yapılıyor…",
    logoutError: "Çıkış tamamlanamadı. Hesabın hâlâ bağlı; tekrar dene.", expired: "Oturumun sona erdi. Devam etmek için yeniden giriş yap.",
    receiptsDescription: "Sana ait denemeleri, gönderilen sonuçları ve kaydedilen ilerlemeyi görüntüle.",
    attempts: "Denemeler", submissions: "Gönderilen sonuçlar", checkpoints: "Kaydedilen ilerleme", recordsLoading: "Katkı kayıtları yükleniyor…",
    recordsError: "Katkı kayıtlarına ulaşılamadı. Tekrar dene.", empty: "Bu bölümde henüz katkı kaydın yok.",
    guest: "Katkı kayıtlarını görmek için hesabına giriş yap.", task: "Görev", created: "Kayıt tarihi", more: "Daha fazla göster", status: "Durum",
    unknown: "Durum güncelleniyor", reserved: "Ayrıldı", active: "Devam ediyor", stop_requested: "Durdurulması bekleniyor", stopped: "Durduruldu", released: "Bırakıldı", completed: "Tamamlandı", expiredStatus: "Süresi doldu", submitted: "Gönderildi", verified: "Doğrulandı", accepted: "Kabul edildi", rejected: "Reddedildi", awaiting_review: "İnceleme bekliyor", usable: "Devam için hazır", verifying: "Doğrulanıyor", cancelled: "İptal edildi", exhausted: "Süre sınırına ulaştı", failed: "Tamamlanamadı",
    verified_candidate: "Doğrulandı, inceleme bekliyor", in_review: "İnceleniyor", changes_requested: "Düzenleme istendi",
  },
  en: {
    account: "My account", contributions: "My contributions", description: "Connect your account to view your own contribution records.",
    privacy: "Connecting an account alone does not start a task. Supported tasks also require a selected profile and explicit approval to run.",
    loading: "Checking your account…", offline: "Your account could not load. Check your connection and try again.",
    retry: "Try again", signIn: "Sign in", github: "Sign in with GitHub", google: "Sign in with Google",
    preparing: "Account connection is being prepared", preparingText: "Sign-in options will appear here when they are ready.",
    providerError: "Sign-in options could not load.", signedIn: "Connected account", logout: "Sign out", loggingOut: "Signing out…",
    logoutError: "Sign-out could not complete. Your account is still connected; try again.", expired: "Your session has expired. Sign in again to continue.",
    receiptsDescription: "View your own attempts, submitted results and saved progress.",
    attempts: "Attempts", submissions: "Submitted results", checkpoints: "Saved progress", recordsLoading: "Loading contribution records…",
    recordsError: "Your contribution records could not load. Try again.", empty: "You have no contribution records in this section yet.",
    guest: "Sign in to see your contribution records.", task: "Task", created: "Recorded on", more: "Show more", status: "Status",
    unknown: "Status updating", reserved: "Reserved", active: "In progress", stop_requested: "Waiting to stop", stopped: "Stopped", released: "Released", completed: "Completed", expiredStatus: "Expired", submitted: "Submitted", verified: "Verified", accepted: "Accepted", rejected: "Rejected", awaiting_review: "Awaiting review", usable: "Ready to continue", verifying: "Verifying", cancelled: "Cancelled", exhausted: "Time limit reached", failed: "Could not complete",
    verified_candidate: "Verified, awaiting review", in_review: "Under review", changes_requested: "Changes requested",
  },
};
type Kind = "leases" | "submissions" | "checkpoints";
const knownStates = new Set(["reserved", "active", "stop_requested", "stopped", "released", "completed", "submitted", "verified", "accepted", "rejected", "awaiting_review", "usable", "verifying", "cancelled", "exhausted", "failed", "verified_candidate", "in_review", "changes_requested"]);
type Receipt = { id: string; task: string; state: string; created: string };
type Receipts = { owner: string; kind: Kind; status: "loading" | "ready" | "error"; items: Receipt[]; next: string; pending: boolean };
function readReceipt(value: unknown, kind: Kind): Receipt {
  if (!value || typeof value !== "object") throw new Error("Unexpected record");
  const raw = value as Record<string, unknown>;
  const metadata = kind === "checkpoints" ? raw.metadata as Record<string, unknown> : raw;
  if (!metadata || typeof metadata !== "object") throw new Error("Unexpected record");
  const created = boundedText(raw.created_at, 64);
  if (!Number.isFinite(Date.parse(created))) throw new Error("Unexpected record date");
  return { id: boundedText(kind === "checkpoints" ? metadata.checkpoint_id : raw.id), task: boundedText(metadata.task_id), state: boundedText(kind === "leases" ? raw.state : raw.status, 64), created };
}
type Opened = { owner: string; kind: Kind; id: string };
export function AccountPanel({ account, language, contributions = false, resumeTarget = null }: { account: Account; language: "tr" | "en"; contributions?: boolean; resumeTarget?: ResumeTarget | null }) {
  const t = words[language];
  const [kind, setKind] = useState<Kind>("leases");
  const [records, setRecords] = useState<Receipts | null>(null);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const returnTo = useRef("");
  const owner = account.state.status === "authenticated" ? account.state.session.user.id : "";
  async function load(ownerID: string, selectedKind: Kind, after = "") {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const timeout = window.setTimeout(() => request.abort(), 10_000);
    if (after) setRecords((current) => current ? { ...current, pending: true } : current);
    else setRecords({ owner: ownerID, kind: selectedKind, status: "loading", items: [], next: "", pending: false });
    try {
      const data = await accountJSON(`/api/v1/me/${selectedKind}${after ? `?after=${encodeURIComponent(after)}` : ""}`, request.signal);
      if (controller.current !== request) return;
      if (!Array.isArray(data?.items) || data.items.length > 100 || (data.next_cursor !== undefined && typeof data.next_cursor !== "string")) throw new Error("Unexpected records");
      const items = data.items.map((item: unknown) => readReceipt(item, selectedKind));
      const next = data.next_cursor ? boundedText(data.next_cursor) : "";
      setRecords((current) => ({ owner: ownerID, kind: selectedKind, status: "ready", items: after && current?.owner === ownerID && current.kind === selectedKind ? [...current.items, ...items] : items, next, pending: false }));
    } catch (error) {
      if (controller.current !== request) return;
      if (error instanceof AccountExpired) { setRecords(null); account.expire(); }
      else setRecords({ owner: ownerID, kind: selectedKind, status: "error", items: [], next: "", pending: false });
    } finally { window.clearTimeout(timeout); }
  }
  useEffect(() => {
    setRecords(null); setOpened(null);
    if (owner && contributions) void load(owner, kind);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [owner, contributions, kind, retry]);
  // Focus returns to the record that opened the panel once the panel has gone.
  useEffect(() => {
    if (opened || !returnTo.current) return;
    const target = openers.current.get(returnTo.current);
    returnTo.current = "";
    target?.focus();
  }, [opened]);
  const panel = opened && opened.owner === owner && opened.kind === kind ? opened : null;
  const close = () => { returnTo.current = panel ? panel.id : ""; setOpened(null); };
  const expireAll = () => { setRecords(null); setOpened(null); account.expire(); };
  const statusLabel = (state: string) => state === "expired" ? t.expiredStatus : knownStates.has(state) ? t[state as keyof typeof t] : t.unknown;
  const visible = records?.owner === owner && records.kind === kind ? records : null;
  const providerName = (provider: string) => provider === "github" ? "GitHub" : "Google";
  return <div className="settings-content account-content">
    <div className="eyebrow">CommonGrid</div>
    <h1>{contributions ? t.contributions : t.account}</h1>
    <p className="page-description">{contributions ? t.receiptsDescription : t.description}</p>
    {account.state.status === "loading" ? <div className="empty-state" role="status">{t.loading}</div>
      : account.state.status === "error" ? <div className="empty-state" role="alert"><p>{t.offline}</p><button className="secondary-button" onClick={() => void account.refresh()}>{t.retry}</button></div>
      : account.state.status !== "authenticated" ? <section className="settings-box">
        {account.state.status === "expired" && <p className="account-alert" role="alert">{t.expired}</p>}
        <h2>{contributions ? t.guest : t.signIn}</h2>
        {account.providers === null ? <><p role="alert">{t.providerError}</p><button className="secondary-button" onClick={() => void account.refresh()}>{t.retry}</button></>
          : account.providers.some((p) => p.enabled) ? <div className="account-actions">{account.providers.filter((p) => p.enabled).map((provider) => <button key={provider.id} className="primary-button" onClick={() => window.location.assign(`/api/v1/auth/${provider.id}/start`)}>{t[provider.id]}</button>)}</div>
          : <div role="status"><strong>{t.preparing}</strong><p className="muted-note">{t.preparingText}</p></div>}
      </section>
      : <>
        <section className="settings-box account-summary"><div><h2>{t.signedIn}</h2><strong data-testid="account-name">{account.state.session.user.display_name}</strong><p className="muted-note">{providerName(account.state.session.user.provider)}</p></div><button className="secondary-button" onClick={() => void account.logout()} disabled={account.logoutPending}>{account.logoutPending ? t.loggingOut : t.logout}</button></section>
        {account.logoutError && <p className="account-alert" role="alert">{t.logoutError}</p>}
        {contributions && <section aria-label={t.contributions}>
          <div className="filter-tabs" role="group" aria-label={t.contributions}>{(["leases", "submissions", "checkpoints"] as const).map((item, index) => <button key={item} className={kind === item ? "selected" : ""} aria-pressed={kind === item} onClick={() => setKind(item)}>{[t.attempts, t.submissions, t.checkpoints][index]}</button>)}</div>
          {!visible || visible.status === "loading" ? <div className="empty-state" role="status">{t.recordsLoading}</div>
            : visible.status === "error" ? <div className="empty-state" role="alert"><p>{t.recordsError}</p><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>{t.retry}</button></div>
            : <div className={panel ? "contribution-layout has-detail" : "contribution-layout"}><div>{!visible.items.length ? <div className="empty-state" role="status">{t.empty}</div> : <ul className="receipt-list">{visible.items.map((record) => <li className={panel?.id === record.id ? "receipt-card opened" : "receipt-card"} key={record.id}><button className="receipt-open" ref={(node) => { if (node) openers.current.set(record.id, node); else openers.current.delete(record.id); }} aria-expanded={panel?.id === record.id} aria-controls="contribution-detail" onClick={() => setOpened({ owner, kind, id: record.id })}><strong>{t.task}: {record.task}</strong><span className="receipt-date">{t.created}: {new Date(record.created).toLocaleString(language)}</span></button><span className="receipt-status" aria-label={t.status}>{statusLabel(record.state)}</span></li>)}</ul>}{visible.next && <button className="secondary-button" disabled={visible.pending} onClick={() => void load(owner, kind, visible.next)}>{visible.pending ? t.recordsLoading : t.more}</button>}</div>
              {panel && <ContributionDetailPanel key={`${panel.owner}:${panel.kind}:${panel.id}`} kind={panel.kind} recordID={panel.id} language={language} statusLabel={statusLabel} resumeTarget={resumeTarget} onClose={close} onExpired={expireAll} />}</div>}
        </section>}
      </>}
    <p className="muted-note">{t.privacy}</p>
  </div>;
}
