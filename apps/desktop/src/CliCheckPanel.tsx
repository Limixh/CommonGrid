import { useEffect, useRef, useState } from "react";
import { acceptCliCheckUpdate, type CliCheckProvider, type CliCheckStatus } from "@commongrid/agent-adapters/cli-check";
import { cancelCliCheck, cliCheckNative, readCliCheck, startCliCheck } from "./cli-check-client";

const words = {
  tr: {
    title: "CLI bağlantısını kontrol et", description: "Claude Code veya Codex'in sürümünü izole ortamda kontrol eder. AI görevi başlatmaz ve hesabına giriş yapmaz.",
    claude: "Claude Code'u kontrol et", codex: "Codex'i kontrol et", refresh: "Kontrol durumunu yenile", cancel: "Kontrolü iptal et",
    unavailable: "Bu kontrol masaüstü uygulamasında kullanılabilir.", loading: "Kontrol durumu okunuyor…", cancelPending: "İptal isteği gönderiliyor…",
    error: "Kontrol durumu doğrulanamadı. Durumu yenileyerek tekrar dene.", paused: "Otomatik güncelleme durdu. Son durumu yenileyebilirsin.",
    starting: "Kontrol başlatılıyor…", preparing: "Ortam hazırlanıyor…", checking: "CLI sürümü kontrol ediliyor…", cleaning: "Kontrol ortamı kapatılıyor…",
    passed: "CLI bağlantısı doğrulandı", cancelled: "Kontrol iptal edildi", failed: "CLI kontrolü tamamlanamadı", needs_review: "Kontrol ortamının kapanması doğrulanamadı; inceleme gerekli.",
    asset_missing: "Gerekli CLI dosyaları bulunamadı.", asset_invalid: "CLI dosyaları doğrulanamadı.", docker_unavailable: "Docker'a erişilemiyor. Docker'ı başlatıp tekrar dene.",
    image_missing: "Gerekli çalışma ortamı imajı bulunamadı. Ortam kurulumunu tamamlayıp tekrar dene.",
    cli_check_failed: "CLI sürümü alınamadı.", worker_failed: "Kontrol tamamlanamadı.", cleanup_failed: "Kontrol ortamı kapatılamadı.", deadline_exceeded: "Kontrol süre sınırına ulaştı.",
  },
  en: {
    title: "Check CLI connection", description: "Checks the Claude Code or Codex version in an isolated environment. It does not start an AI task or sign in to your account.",
    claude: "Check Claude Code", codex: "Check Codex", refresh: "Refresh check status", cancel: "Cancel check",
    unavailable: "This check is available in the desktop application.", loading: "Reading check status…", cancelPending: "Sending cancellation…",
    error: "The check status could not be validated. Refresh the status to try again.", paused: "Automatic updates stopped. You can refresh the latest status.",
    starting: "Starting check…", preparing: "Preparing environment…", checking: "Checking CLI version…", cleaning: "Closing check environment…",
    passed: "CLI connection verified", cancelled: "Check cancelled", failed: "The CLI check could not complete", needs_review: "The check environment could not be confirmed closed; review is required.",
    asset_missing: "Required CLI files were not found.", asset_invalid: "CLI files could not be verified.", docker_unavailable: "Docker is unavailable. Start Docker and try again.",
    image_missing: "The required runtime image was not found. Complete environment setup and try again.",
    cli_check_failed: "The CLI version could not be read.", worker_failed: "The check could not complete.", cleanup_failed: "The check environment could not close.", deadline_exceeded: "The check reached its time limit.",
  },
};
export function CliCheckPanel({language}: {language: "tr" | "en"}) {
  const t = words[language];
  const [status, setStatus] = useState<CliCheckStatus | null>(null);
  const [pending, setPending] = useState<"read" | "start" | "cancel" | null>("read");
  const [error, setError] = useState(false);
  const [paused, setPaused] = useState(false);
  const snapshot = useRef<CliCheckStatus | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const pollCount = useRef(0);

  async function observe(kind: "read" | "start" | "cancel", provider?: CliCheckProvider) {
    if (mutation.current) return;
    if (kind !== "read") mutation.current = true;
    waiting.current?.abort();
    const controller = new AbortController(); waiting.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    setPending(kind);
    try {
      const before = snapshot.current;
      const operation = before?.operation;
      const checked = kind === "start"
        ? await startCliCheck({schema_version: "1.0", request_id: crypto.randomUUID(), provider: provider!}, controller.signal)
        : kind === "cancel"
          ? await cancelCliCheck({schema_version: "1.0", request_id: operation!.request_id, expected_revision: operation!.revision}, controller.signal)
          : await readCliCheck(controller.signal);
      if (waiting.current !== controller || controller.signal.aborted) return;
      const next = acceptCliCheckUpdate(before, checked);
      snapshot.current = next; setStatus(next); setError(false);
      if (kind !== "read") { pollCount.current = 0; setPaused(false); }
    } catch {
      if (waiting.current === controller) { setError(true); setPaused(true); }
    } finally {
      window.clearTimeout(timeout);
      if (waiting.current === controller) { waiting.current = null; mutation.current = false; setPending(null); }
    }
  }
  function refresh() { pollCount.current = 0; setPaused(false); void observe("read"); }
  useEffect(() => {
    void observe("read");
    return () => { waiting.current?.abort(); waiting.current = null; mutation.current = false; };
  }, []);
  const operation = status?.operation;
  const active = !!operation && operation.phase !== "finished";
  useEffect(() => {
    if (!active || pending || paused || error) return;
    if (pollCount.current >= 420) { setPaused(true); return; }
    const timeout = window.setTimeout(() => { pollCount.current++; void observe("read"); }, 1000);
    return () => window.clearTimeout(timeout);
  }, [active, status, pending, paused, error]);
  const canStart = status?.availability === "available" && !active && !pending && !error && operation?.outcome !== "needs_review";
  return <section className="settings-box cli-check-panel" aria-labelledby="cli-check-title" aria-busy={pending !== null}>
    <div className="section-heading"><h2 id="cli-check-title">{t.title}</h2>{cliCheckNative() && <button className="secondary-button" disabled={pending === "start" || pending === "cancel"} onClick={refresh}>{t.refresh}</button>}</div>
    <p>{t.description}</p>
    <div className="cli-check-actions">
      <button className="secondary-button" disabled={!canStart} onClick={() => void observe("start", "claude")}>{t.claude}</button>
      <button className="secondary-button" disabled={!canStart} onClick={() => void observe("start", "codex")}>{t.codex}</button>
      {active && <button className="secondary-button" disabled={pending === "start" || pending === "cancel" || operation.phase === "cleaning"} onClick={() => void observe("cancel")}>{t.cancel}</button>}
    </div>
    {status?.availability === "unavailable" && <p role="status">{t.unavailable}</p>}
    {pending === "read" && !operation && <p role="status">{t.loading}</p>}
    {pending === "cancel" && <p role="status">{t.cancelPending}</p>}
    {error && <p role="alert">{t.error}</p>}
    {operation && <div className="cli-check-result" role="status">
      <strong>{operation.provider === "claude" ? "Claude Code" : "Codex"} · {operation.phase === "finished" ? t[operation.outcome!] : t[operation.phase]}</strong>
      {operation.cli_version && <code data-testid="cli-check-version">{operation.cli_version}</code>}
      {operation.error_code && operation.error_code !== "cancelled" && <p>{t[operation.error_code]}</p>}
    </div>}
    {paused && active && !error && <p role="status">{t.paused}</p>}
  </section>;
}
