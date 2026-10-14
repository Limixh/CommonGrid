import { useEffect, useRef, useState } from "react";
import {
  acceptProfileSessionUpdate, validateClaudeLoginCode, type ProfileSessionAction, type ProfileSessionChallenge, type ProfileSessionOperation, type ProfileSessionStatus,
} from "@commongrid/agent-adapters/profile-session";
import type { ManagedProfile } from "@commongrid/agent-adapters/managed-profiles";
import { cancelProfileSession, openProfileSessionClaude, openProfileSessionDevice, profileSessionNative, readProfileSession, startProfileSession, submitProfileSessionCode } from "./profile-session-client";

const words = {
  tr: {
    title: "Seçili profilin CLI hesabı", description: "Profil seçimi hesap bağlantısını doğrulamaz. Seçili profilin resmi CLI hesap durumunu burada kontrol edebilirsin.",
    refresh: "Bağlantı durumunu yenile", status: "CLI hesabını kontrol et", login: "Codex hesabını bağla", logout: "CLI hesabından çıkış yap", cancel: "Bağlantı işlemini iptal et",
    unavailable: "Hesap bağlantısı masaüstü uygulamasında kullanılabilir.", loading: "Bağlantı durumu okunuyor…", submitting: "İstek gönderiliyor…", cancelPending: "İptal isteği gönderiliyor…",
    error: "Bağlantı durumu doğrulanamadı. Son durumu yenileyip tekrar dene.", paused: "Otomatik güncelleme durdu. Son durumu yenileyebilirsin.",
    unknown: "CLI hesabı henüz doğrulanmadı.", authenticated: "CLI hesabı bağlı.", unauthenticated: "CLI hesabı bağlı değil.", otherProfile: "Başka bir profilin bağlantı işlemi sürüyor.",
    claude: "Claude Code'un resmi giriş sayfasında kendi hesabınla giriş yap. Sayfanın verdiği geçici kodu yalnız bu uygulamaya gir; sohbete gönderme.",
    claudeLogin: "Claude hesabını bağla", claudeOpen: "Claude giriş sayfasını aç", claudeCode: "Claude geçici giriş kodu", claudeSubmit: "Giriş kodunu gönder", claudeSent: "Giriş kodu resmi CLI'a gönderildi. Bağlantı sonucu bekleniyor…", claudeInvalid: "Resmi giriş sayfasının verdiği kodu eksiksiz gir.",
    starting: "Bağlantı işlemi başlatılıyor…", preparing: "Profil ortamı hazırlanıyor…", checking: "CLI hesap işlemi sürüyor…", waiting_for_login: "Tarayıcıda giriş yapman bekleniyor…", cleaning: "Bağlantı ortamı kapatılıyor…",
    passed: "CLI hesap işlemi tamamlandı", cancelled: "Bağlantı işlemi iptal edildi", failed: "CLI hesap işlemi tamamlanamadı", needs_review: "İnceleme gerekli; bu profilde yeni hesap işlemi başlatılmaz.",
    device: "Resmi Codex giriş sayfasını aç ve bu kodu gir:", open: "Codex giriş sayfasını aç", code: "Geçici giriş kodu",
    asset_missing: "Gerekli CLI dosyaları bulunamadı.", asset_invalid: "CLI dosyaları doğrulanamadı.", docker_unavailable: "Docker'a erişilemiyor. Docker'ı başlatıp tekrar dene.",
    image_missing: "Gerekli çalışma ortamı imajı bulunamadı. Ortam kurulumunu tamamlayıp tekrar dene.", profile_invalid: "Profil doğrulanamadı. Profilleri yenileyip tekrar dene.",
    profile_needs_review: "Bu profilde önceki bir işlem kapanmadı veya doğrulanamadı; hesap işlemi başlatılmadı. Ajanlar ve ortam sayfasındaki Yerel işlem günlüğü panelinden kayıtları incele.", auth_required: "Resmi CLI hesabına giriş gerekli.", unsupported: "Bu CLI hesap işlemi henüz desteklenmiyor.",
    session_failed: "CLI hesap işlemi tamamlanamadı.", worker_failed: "Bağlantı işlemi tamamlanamadı.", cleanup_failed: "Bağlantı ortamı kapatılamadı.", deadline_exceeded: "Bağlantı işlemi süre sınırına ulaştı.",
  },
  en: {
    title: "Selected profile's CLI account", description: "Selecting a profile does not verify account connection. Check the selected profile's official CLI account status here.",
    refresh: "Refresh connection status", status: "Check CLI account", login: "Connect Codex account", logout: "Sign out of CLI account", cancel: "Cancel account operation",
    unavailable: "Account connection is available in the desktop application.", loading: "Reading connection status…", submitting: "Sending request…", cancelPending: "Sending cancellation…",
    error: "The connection status could not be validated. Refresh the latest status and try again.", paused: "Automatic updates stopped. You can refresh the latest status.",
    unknown: "The CLI account has not been verified yet.", authenticated: "The CLI account is connected.", unauthenticated: "The CLI account is not connected.", otherProfile: "Another profile's account operation is running.",
    claude: "Sign in with your own account on Claude Code's official sign-in page. Enter its temporary code only in this application; do not send it in chat.",
    claudeLogin: "Connect Claude account", claudeOpen: "Open Claude sign-in page", claudeCode: "Claude temporary sign-in code", claudeSubmit: "Submit sign-in code", claudeSent: "The code was sent to the official CLI. Waiting for the connection result…", claudeInvalid: "Enter the complete code provided by the official sign-in page.",
    starting: "Starting account operation…", preparing: "Preparing profile environment…", checking: "CLI account operation is running…", waiting_for_login: "Waiting for you to sign in with your browser…", cleaning: "Closing account environment…",
    passed: "CLI account operation completed", cancelled: "Account operation cancelled", failed: "The CLI account operation could not complete", needs_review: "Review required; no new account operation starts on this profile.",
    device: "Open the official Codex sign-in page and enter this code:", open: "Open Codex sign-in page", code: "Temporary sign-in code",
    asset_missing: "Required CLI files were not found.", asset_invalid: "CLI files could not be verified.", docker_unavailable: "Docker is unavailable. Start Docker and try again.",
    image_missing: "The required runtime image was not found. Complete environment setup and try again.", profile_invalid: "The profile could not be verified. Refresh profiles and try again.",
    profile_needs_review: "An earlier operation on this profile was not closed or could not be verified; the account operation did not start. Review the records in the Local operation journal panel on the Agents & environment page.", auth_required: "Sign in to the official CLI account.", unsupported: "This CLI account operation is not supported yet.",
    session_failed: "The CLI account operation could not complete.", worker_failed: "The account operation could not complete.", cleanup_failed: "The account environment could not close.", deadline_exceeded: "The account operation reached its time limit.",
  },
};

async function cancelDepartingLogin(operation: ProfileSessionOperation) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    try {
      await cancelProfileSession({schema_version: "1.0", request_id: operation.request_id, expected_revision: operation.revision}, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      const latest = (await readProfileSession(controller.signal)).operation;
      if (latest?.request_id === operation.request_id && latest.profile_id === operation.profile_id &&
        latest.provider === operation.provider && latest.action === "login" && latest.phase !== "finished") {
        await cancelProfileSession({schema_version: "1.0", request_id: latest.request_id, expected_revision: latest.revision}, controller.signal);
      }
    }
  } catch { /* Best effort; the native deadline still owns CLI cleanup. */ }
  finally { window.clearTimeout(timeout); }
}

export function ProfileSessionPanel({language, profile}: {language: "tr" | "en"; profile: ManagedProfile}) {
  const t = words[language];
  const [status, setStatus] = useState<ProfileSessionStatus | null>(null);
  const [challenge, setChallenge] = useState<ProfileSessionChallenge | null>(null);
  const [pending, setPending] = useState<"read" | "start" | "cancel" | "submit" | null>("read");
  const [loginCode, setLoginCode] = useState("");
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState(false);
  const [paused, setPaused] = useState(false);
  const [openPending, setOpenPending] = useState(false);
  // Observation metadata never retains a temporary code or authorization URL.
  const snapshot = useRef<ProfileSessionStatus | null>(null);
  const challengeFingerprint = useRef<string | null>(null);
  const hiddenRequest = useRef<string | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const opening = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const pollCount = useRef(0);
  const pollStarted = useRef(Date.now());

  async function observe(kind: "read" | "start" | "cancel" | "submit", action?: ProfileSessionAction, code?: string) {
    if (mutation.current) return;
    const before = snapshot.current;
    const operation = before?.operation;
    if (kind === "start" && (!before || before.availability !== "available" ||
      operation && (operation.phase !== "finished" || operation.outcome === "needs_review"))) return;
    if (kind === "cancel" && (!operation || operation.profile_id !== profile.profile_id || operation.phase === "finished")) return;
    if (kind === "submit" && (!operation || operation.profile_id !== profile.profile_id || operation.provider !== "claude" ||
      operation.action !== "login" || operation.phase !== "waiting_for_login" || !challenge || !("authorization_url" in challenge) || !code)) return;
    if (kind !== "read") mutation.current = true;
    if (kind === "cancel" || kind === "submit") {
      if (kind === "cancel") hiddenRequest.current = operation?.request_id ?? null;
      setChallenge(null); setLoginCode(""); setCodeInvalid(false); setCodeSent(false);
      opening.current?.abort(); opening.current = null; setOpenPending(false);
    }
    waiting.current?.abort();
    const controller = new AbortController(); waiting.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    setPending(kind);
    try {
      const checked = kind === "start"
        ? await startProfileSession({schema_version: "1.0", request_id: crypto.randomUUID(), profile_id: profile.profile_id, action: action!}, controller.signal)
        : kind === "cancel"
          ? await cancelProfileSession({schema_version: "1.0", request_id: operation!.request_id, expected_revision: operation!.revision}, controller.signal)
          : kind === "submit"
            ? await submitProfileSessionCode({schema_version: "1.0", request_id: operation!.request_id, expected_revision: operation!.revision, code: code!}, controller.signal)
            : await readProfileSession(controller.signal);
      const incoming = checked.operation;
      const transient = incoming?.profile_id === profile.profile_id ? incoming.challenge : null;
      // Compare same-revision changes without retaining challenge secrets in metadata.
      const fingerprint = incoming?.challenge ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(incoming.challenge).sort()))))), byte => byte.toString(16).padStart(2, "0")).join("") : null;
      if (waiting.current !== controller || controller.signal.aborted) return;
      if (incoming?.profile_id === profile.profile_id && incoming.provider !== profile.provider) throw new Error("profile_session_contract_invalid");
      if (operation && incoming?.request_id === operation.request_id && incoming.revision === operation.revision && challengeFingerprint.current !== fingerprint)
        throw new Error("profile_session_status_stale");
      const next = acceptProfileSessionUpdate(before, {...checked, operation: incoming ? {...incoming, challenge: null} : null});
      if (fingerprint !== challengeFingerprint.current || operation?.request_id !== incoming?.request_id || operation?.revision !== incoming?.revision || !transient) {
        setLoginCode(""); setCodeInvalid(false);
      }
      snapshot.current = next; challengeFingerprint.current = fingerprint; setStatus(next); setError(false);
      setChallenge(incoming?.request_id === hiddenRequest.current ? null : transient);
      if (kind === "submit") setCodeSent(incoming?.phase === "waiting_for_login");
      else if (incoming?.phase !== "waiting_for_login" || operation?.request_id !== incoming?.request_id) setCodeSent(false);
      if (!transient || incoming?.request_id === hiddenRequest.current) {
        opening.current?.abort(); opening.current = null; setOpenPending(false);
      }
      if (kind !== "read" || operation?.request_id !== incoming?.request_id) { pollCount.current = 0; pollStarted.current = Date.now(); setPaused(false); }
    } catch {
      if (waiting.current === controller) {
        setChallenge(null); setLoginCode(""); setCodeInvalid(false); setCodeSent(false); setError(true); setPaused(true);
        opening.current?.abort(); opening.current = null; setOpenPending(false);
      }
    } finally {
      window.clearTimeout(timeout);
      if (waiting.current === controller) { waiting.current = null; mutation.current = false; setPending(null); }
    }
  }
  async function openDevice() {
    const operation = snapshot.current?.operation;
    if (!challenge || !operation || operation.profile_id !== profile.profile_id || !profileSessionNative() || opening.current || mutation.current) return;
    const controller = new AbortController(); opening.current = controller; setOpenPending(true);
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      if ("authorization_url" in challenge) await openProfileSessionClaude({schema_version: "1.0", request_id: operation.request_id, expected_revision: operation.revision}, controller.signal);
      else await openProfileSessionDevice(controller.signal);
    }
    catch { if (opening.current === controller) { setChallenge(null); setLoginCode(""); setCodeInvalid(false); setCodeSent(false); setError(true); setPaused(true); } }
    finally {
      window.clearTimeout(timeout);
      if (opening.current === controller) { opening.current = null; setOpenPending(false); }
    }
  }
  function submitCode() {
    if (mutation.current || !challenge || !("authorization_url" in challenge)) return;
    const code = loginCode; setLoginCode(""); setCodeInvalid(false);
    try { validateClaudeLoginCode(code, challenge.authorization_url); }
    catch { setCodeInvalid(true); return; }
    void observe("submit", undefined, code);
  }
  function refresh() { setLoginCode(""); setCodeInvalid(false); pollCount.current = 0; pollStarted.current = Date.now(); setPaused(false); void observe("read"); }
  useEffect(() => {
    void observe("read");
    return () => {
      waiting.current?.abort(); waiting.current = null; mutation.current = false;
      opening.current?.abort(); opening.current = null;
      const operation = snapshot.current?.operation;
      snapshot.current = null; challengeFingerprint.current = null; hiddenRequest.current = null;
      setChallenge(null); setLoginCode(""); setCodeInvalid(false); setCodeSent(false);
      if (operation?.profile_id === profile.profile_id && operation.action === "login" && operation.phase !== "finished") {
        void cancelDepartingLogin(operation);
      }
    };
  }, []);
  const operation = status?.operation;
  const active = !!operation && operation.phase !== "finished";
  const ours = operation?.profile_id === profile.profile_id;
  useEffect(() => {
    if (!active || pending || paused || error) return;
    const limit = operation?.action === "login" ? 720 : 420;
    if (pollCount.current >= limit || Date.now() - pollStarted.current >= limit * 1000) {
      setChallenge(null); setLoginCode(""); setCodeInvalid(false); setCodeSent(false); setPaused(true); opening.current?.abort(); opening.current = null; setOpenPending(false); return;
    }
    const timeout = window.setTimeout(() => { pollCount.current++; void observe("read"); }, 1000);
    return () => window.clearTimeout(timeout);
  }, [active, status, pending, paused, error]);
  const enabled = status?.availability === "available" && !active && !pending && !error && operation?.outcome !== "needs_review";
  return <section className="profile-session-panel" aria-labelledby="profile-session-title" aria-busy={pending !== null}>
    <div className="section-heading"><h3 id="profile-session-title">{t.title}</h3>{profileSessionNative() && <button className="secondary-button" disabled={pending === "start" || pending === "cancel" || pending === "submit"} onClick={refresh}>{t.refresh}</button>}</div>
    <p>{t.description}</p>
    <p role="status">{ours && !active && !error && pending !== "start" ? t[operation.session_state] : t.unknown}</p>
    {profile.provider === "claude" && <p>{t.claude}</p>}
    <div className="cli-check-actions">
      <button className="secondary-button" disabled={!enabled} onClick={() => void observe("start", "status")}>{t.status}</button>
      <button className="secondary-button" disabled={!enabled} onClick={() => void observe("start", "login")}>{profile.provider === "claude" ? t.claudeLogin : t.login}</button>
      <button className="secondary-button" disabled={!enabled} onClick={() => void observe("start", "logout")}>{t.logout}</button>
      {ours && active && <button className="secondary-button" disabled={pending === "start" || pending === "cancel" || pending === "submit" || operation.phase === "cleaning"} onClick={() => void observe("cancel")}>{t.cancel}</button>}
    </div>
    {status?.availability === "unavailable" && <p role="status">{t.unavailable}</p>}
    {pending === "read" && !status && <p role="status">{t.loading}</p>}
    {pending === "start" && <p role="status">{t.submitting}</p>}
    {pending === "cancel" && <p role="status">{t.cancelPending}</p>}
    {pending === "submit" && <p role="status">{t.submitting}</p>}
    {error && <p role="alert">{t.error}</p>}
    {!ours && active && <p role="status">{t.otherProfile}</p>}
    {ours && <div className="cli-check-result" role="status">
      <strong>{operation.phase === "finished" ? t[operation.outcome!] : t[operation.phase]}</strong>
      {operation.error_code && operation.error_code !== "cancelled" && <p>{t[operation.error_code]}</p>}
    </div>}
    {challenge && "user_code" in challenge && !error && <div className="profile-session-challenge">
      <p>{t.device}</p><code aria-label={t.code} data-testid="profile-session-code">{challenge.user_code}</code>
      <button className="secondary-button" disabled={openPending || pending === "cancel"} onClick={() => void openDevice()}>{t.open}</button>
    </div>}
    {challenge && "authorization_url" in challenge && !error && <div className="profile-session-challenge">
      <button className="secondary-button" disabled={openPending || pending === "cancel" || pending === "submit"} onClick={() => void openDevice()}>{t.claudeOpen}</button>
      <form onSubmit={event => { event.preventDefault(); submitCode(); }} autoComplete="off">
        <label htmlFor="claude-login-code">{t.claudeCode}</label>
        <input id="claude-login-code" type="password" value={loginCode} onChange={event => { setLoginCode(event.target.value); setCodeInvalid(false); }} maxLength={2048} autoComplete="off" spellCheck={false} autoCapitalize="none" aria-invalid={codeInvalid} aria-describedby={codeInvalid ? "claude-code-error" : undefined} disabled={pending === "cancel" || pending === "submit"} />
        <button className="secondary-button" type="submit" disabled={!loginCode || pending === "cancel" || pending === "submit"}>{t.claudeSubmit}</button>
        {codeInvalid && <p id="claude-code-error" role="alert">{t.claudeInvalid}</p>}
      </form>
    </div>}
    {codeSent && ours && active && !error && <p role="status">{t.claudeSent}</p>}
    {paused && active && !error && <p role="status">{t.paused}</p>}
  </section>;
}
