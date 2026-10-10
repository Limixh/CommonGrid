/// <reference types="vite/client" />
import { useEffect, useRef, useState } from "react";
import { createOperationReviewRequest, validateRecoveryStatus, type RecoveryStatus } from "@commongrid/agent-adapters/recovery";

const words = {
  tr: {
    title: "Yerel işlem günlüğü", description: "Geliştirici çalışma ortamındaki geçmiş kayıtları gösterir. Kayıtlar, Docker'ın güncel durumunu veya önceki çalışanın durduğunu kanıtlamaz.",
    refresh: "İşlem kayıtlarını yenile", loading: "İşlem kayıtları okunuyor…", unavailable: "Yerel işlem günlüğü kullanılamıyor.", blocked: "İşlem kayıtları doğrulanamadı; inceleme gerekli.", native: "Paketlenmiş masaüstü sürümünde yerel işlem durumu bağlantısı henüz hazır değil.", empty: "Günlükte işlem kaydı yok. Bu, çalışır kaynak bulunmadığının kanıtı değildir.",
    gate: "Görev başlatma ve otomatik kurtarma kapalı. Çalışanın durumu ve Docker durumu bilinmiyor.", review: "İnceleme isteğini göster", request: "Salt okunur inceleme isteği", requestNote: "Bu istek yalnız kimlik ve günlük sürümünü bağlar. Temizleme, devralma veya yeniden başlatma yetkisi vermez. İşlem değişmişse yeni kayıtla tekrar incele.",
    complete: "Günlükte tamamlanmış", needsReview: "İnceleme gerekli", pending: "Sonucu doğrulanmamış işlem", namespaces: "Kaydedilmiş namespace", durability: "Kalıcılık", process: "Süreç kesintisine karşı kayıt", synced: "Dosya ve dizin senkronizasyonu", revision: "Günlük sürümü", showing: "Gösterilen / toplam kayıt", more: "Daha fazla kayıt göster",
  },
  en: {
    title: "Local operation journal", description: "Shows historical records from the developer environment. Records do not prove Docker's current state or that the previous worker has stopped.",
    refresh: "Refresh operation records", loading: "Reading operation records…", unavailable: "The local operation journal is unavailable.", blocked: "Operation records could not be validated; review is required.", native: "The packaged desktop version does not yet have a local operation status connection.", empty: "The journal has no operation records. This does not prove that running resources are absent.",
    gate: "Task execution and automatic recovery are disabled. Worker and Docker states are unknown.", review: "Show review request", request: "Read-only review request", requestNote: "This request binds only the identity and journal revision. It grants no cleanup, takeover or restart authority. If the operation changes, review a fresh record.",
    complete: "Recorded complete", needsReview: "Review required", pending: "Unconfirmed operation", namespaces: "Recorded namespace", durability: "Durability", process: "Process interruption record", synced: "File and directory synchronized", revision: "Journal revision", showing: "Shown / total records", more: "Show more records",
  },
};
export function OperationRecoveryPanel({language}: {language: "tr" | "en"}) {
  const t = words[language];
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [state, setState] = useState<"loading" | "available" | "unavailable" | "blocked">("loading");
  const [request, setRequest] = useState("");
  const [shown, setShown] = useState(50);
  const activeRequest = useRef<AbortController | null>(null);
  async function refresh() {
    activeRequest.current?.abort();
    setRequest(""); setStatus(null); setShown(50);
    if (!import.meta.env.DEV) { setState("unavailable"); return; }
    const controller = new AbortController(); activeRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    setState("loading");
    try {
      const response = await fetch("/local-operation-status", {credentials: "same-origin", signal: controller.signal});
      if (!response.ok) throw new Error("operation_status_unavailable");
      const body = await response.text();
      if (body.length > 1048576) throw new Error("invalid_response");
      const checked = validateRecoveryStatus(JSON.parse(body));
      if (activeRequest.current !== controller || controller.signal.aborted) return;
      setStatus(checked); setState(checked.status);
    } catch {
      if (activeRequest.current !== controller) return;
      setStatus(null); setState("blocked");
    } finally { window.clearTimeout(timeout); }
  }
  useEffect(() => { void refresh(); return () => {activeRequest.current?.abort(); activeRequest.current = null;}; }, []);
  return <section className="settings-box operation-recovery" aria-labelledby="operation-recovery-title">
    <div className="section-heading"><h2 id="operation-recovery-title">{t.title}</h2>{import.meta.env.DEV && <button className="secondary-button" onClick={() => void refresh()} disabled={state === "loading"}>{t.refresh}</button>}</div>
    <p>{t.description}</p><p className="muted-note">{t.gate}</p>
    {state === "loading" && <p role="status">{t.loading}</p>}
    {state === "unavailable" && <p role="status">{import.meta.env.DEV ? t.unavailable : t.native}</p>}
    {state === "blocked" && <p role="alert">{t.blocked}</p>}
    {state === "available" && status?.operations.length === 0 && <p role="status">{t.empty}</p>}
    {state === "available" && !!status?.operations.length && <p>{t.showing}: {Math.min(shown, status.operations.length)} / {status.operations.length}</p>}
    {state === "available" && status?.operations.slice(0, shown).map(operation => <article className="operation-record" key={`${operation.identity.owner}/${operation.identity.provider}/${operation.identity.operation}`}>
      <h3>{operation.identity.provider} · {operation.status === "recorded_complete" ? t.complete : t.needsReview}</h3>
      <code>{operation.identity.operation}</code>
      <p>{t.revision}: {operation.last_sequence} · {t.pending}: {operation.pending_count} · {t.namespaces}: {operation.recorded_namespace_count}</p>
      <p>{t.durability}: {operation.durability === "process_crash" ? t.process : t.synced}</p>
      {operation.status === "needs_review" && <button className="secondary-button" onClick={() => setRequest(JSON.stringify(createOperationReviewRequest(status, operation.identity), null, 2))}>{t.review}</button>}
    </article>)}
    {state === "available" && status && status.operations.length > shown && <button className="secondary-button" onClick={() => setShown(current => current + 50)}>{t.more}</button>}
    {request && <div><h3>{t.request}</h3><p>{t.requestNote}</p><pre className="contract-json" data-testid="operation-review-request" tabIndex={0}>{request}</pre></div>}
  </section>;
}
