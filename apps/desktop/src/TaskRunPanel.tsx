import { useEffect, useRef, useState } from "react";
import {
  acceptTaskRunUpdate, taskRunMaxToolCalls, taskRunRequestedModels,
  type TaskRunError, type TaskRunOperation, type TaskRunOutcome, type TaskRunPhase, type TaskRunStatus,
} from "@commongrid/agent-adapters/task-run";
import type { ManagedProfile } from "@commongrid/agent-adapters/managed-profiles";
import { cancelTaskRun, readTaskRun, startTaskRun, taskRunNative } from "./task-run-client";

type Words = {
  title: string; description: string; refresh: string; cardTitle: string; cardText: string; model: string; observed: string; limitsTitle: string;
  limits: string[]; quota: string; approve: string; start: string; cancel: string; unavailable: string; loading: string; submitting: string;
  cancelPending: string; error: string; paused: string; otherProfile: string; otherReview: string; toolCalls: string; verifier: string;
  verifierPassed: (cases: number) => string; verifierRejected: (cases: number, json: boolean, sparse: boolean) => string;
  candidate: string; patch: string; diff: string; copy: string; copied: string; copyFailed: string;
  phases: Record<Exclude<TaskRunPhase, "finished">, string>; outcomes: Record<TaskRunOutcome, string>;
  errors: (model: string) => Record<TaskRunError, string>;
};
const words: Record<"tr" | "en", Words> = {
  tr: {
    title: "Onaylı görev", description: "Hesabı bağlı seçili profille, onayladığın tek bir kontrollü görevi izole ortamda çalıştır ve yalnız doğrulanmış sonucu gör.",
    refresh: "Görev durumunu yenile", cardTitle: "Kontrollü doğrulama görevi: sum.mjs",
    cardText: "Ajan, izole bir ortamda sum.mjs içindeki tamsayı toplama işlevini düzeltir. Sonuç bağımsız doğrulayıcıdan geçerse değişiklik diff olarak gösterilir.",
    model: "Kullanılacak model", observed: "Gözlenen model", limitsTitle: "Sınırlar",
    limits: ["Ağ erişimi yok.", `En fazla ${taskRunMaxToolCalls} araç çağrısı.`, "20 dakika süre sınırı.", "34 örnekli bağımsız doğrulayıcı.", "Yalnız doğrulanmış diff gösterilir."],
    quota: "Bu görev kendi Claude veya Codex aboneliğinin kotasını kullanır.",
    approve: "Bu görevi seçili profilin hesabıyla çalıştırmayı onaylıyorum.", start: "Başlat", cancel: "İptal",
    unavailable: "Görev çalıştırma masaüstü uygulamasında kullanılabilir.", loading: "Görev durumu okunuyor…", submitting: "Görev başlatılıyor…", cancelPending: "İptal isteği gönderiliyor…",
    error: "Görev durumu doğrulanamadı. Son durumu yenileyip tekrar dene.", paused: "Otomatik güncelleme durdu. Son durumu yenileyebilirsin.",
    otherProfile: "Başka bir profilin görevi sürüyor.", otherReview: "Önceki bir görevin kapanışı doğrulanamadı; yeni görev başlatılamaz. İnceleme gerekli.",
    toolCalls: "Araç çağrısı", verifier: "Doğrulayıcı",
    verifierPassed: cases => `${cases}/${cases} örnek geçti`,
    verifierRejected: (cases, json, sparse) => `${cases} örnekli doğrulayıcı adayı reddetti (JSON örnekleri: ${json ? "geçti" : "kaldı"}, seyrek örnekler: ${sparse ? "geçti" : "kaldı"}).`,
    candidate: "Aday SHA-256", patch: "Diff SHA-256", diff: "Doğrulanmış diff", copy: "Diff'i kopyala", copied: "Diff panoya kopyalandı.", copyFailed: "Diff panoya kopyalanamadı.",
    phases: {starting: "Görev başlatılıyor…", preparing: "İzole ortam hazırlanıyor…", running: "Ajan çalışıyor…", verifying: "Bağımsız doğrulayıcı çalışıyor…", cleaning: "Ortam temizleniyor…"},
    outcomes: {
      passed: "Görev doğrulandı", rejected: "Aday doğrulayıcı tarafından reddedildi; diff gösterilmiyor.", cancelled: "Görev iptal edildi",
      failed: "Görev tamamlanamadı", needs_review: "Görev ortamının kapanması doğrulanamadı; inceleme gerekli.",
    },
    errors: model => ({
      asset_missing: "Gerekli CLI dosyaları bulunamadı.", asset_invalid: "CLI dosyaları doğrulanamadı.", docker_unavailable: "Docker'a erişilemiyor. Docker'ı başlatıp tekrar dene.",
      image_missing: "Gerekli çalışma ortamı imajı bulunamadı. Ortam kurulumunu tamamlayıp tekrar dene.", profile_invalid: "Profil doğrulanamadı. Profilleri yenileyip tekrar dene.",
      profile_needs_review: "Profil ortamı inceleme gerektiriyor.",
      profile_unbound: "Bu profil için bağlı bir hesap ortamı yok. Yukarıdaki panelden hesabını bağla.",
      auth_required: "Resmi CLI hesabına giriş gerekli. Yukarıdaki panelden hesabını bağla.",
      model_unavailable: `Test için seçilen ucuz model (${model}) kullanılamadı. Ücretli veya varsayılan bir modele geçilmedi; görev çalıştırılmadı.`,
      quota_exhausted: "Aboneliğinin kullanım sınırına ulaşıldı. Sınır yenilendikten sonra tekrar dene.",
      provider_failed: "Sağlayıcının CLI'ı görevi tamamlayamadı.", tool_limit: `Ajan ${taskRunMaxToolCalls} araç çağrısı sınırına ulaştı.`,
      candidate_invalid: "Ajanın önerdiği değişiklik geçerli bir düzeltme olarak okunamadı.", candidate_rejected: "Bağımsız doğrulayıcı adayı reddetti.",
      verifier_failed: "Bağımsız doğrulayıcı çalıştırılamadı.", worker_failed: "Görev işlemi tamamlanamadı.", cleanup_failed: "Görev ortamı kapatılamadı.",
      deadline_exceeded: "Görev 20 dakikalık süre sınırına ulaştı.", cancelled: "Görev iptal edildi.",
    }),
  },
  en: {
    title: "Approved task", description: "Run one approved, controlled task in an isolated environment with the selected profile whose account is connected, and see only the verified result.",
    refresh: "Refresh task status", cardTitle: "Controlled verification task: sum.mjs",
    cardText: "The agent fixes the integer summing function in sum.mjs inside an isolated environment. If the independent verifier accepts it, the change is shown as a diff.",
    model: "Model that will be used", observed: "Observed model", limitsTitle: "Limits",
    limits: ["No network access.", `At most ${taskRunMaxToolCalls} tool calls.`, "20 minute time limit.", "Independent verifier with 34 cases.", "Only the verified diff is shown."],
    quota: "This task uses the quota of your own Claude or Codex subscription.",
    approve: "I approve running this task with the selected profile's account.", start: "Start", cancel: "Cancel",
    unavailable: "Task runs are available in the desktop application.", loading: "Reading task status…", submitting: "Starting task…", cancelPending: "Sending cancellation…",
    error: "The task status could not be validated. Refresh the latest status and try again.", paused: "Automatic updates stopped. You can refresh the latest status.",
    otherProfile: "Another profile's task is running.", otherReview: "An earlier task's cleanup could not be confirmed; a new task cannot start. Review is required.",
    toolCalls: "Tool calls", verifier: "Verifier",
    verifierPassed: cases => `${cases}/${cases} cases passed`,
    verifierRejected: (cases, json, sparse) => `The ${cases}-case verifier rejected the candidate (JSON cases: ${json ? "passed" : "failed"}, sparse cases: ${sparse ? "passed" : "failed"}).`,
    candidate: "Candidate SHA-256", patch: "Diff SHA-256", diff: "Verified diff", copy: "Copy diff", copied: "Diff copied to the clipboard.", copyFailed: "The diff could not be copied.",
    phases: {starting: "Starting task…", preparing: "Preparing isolated environment…", running: "Agent is working…", verifying: "Independent verifier is running…", cleaning: "Cleaning up environment…"},
    outcomes: {
      passed: "Task verified", rejected: "The verifier rejected the candidate; no diff is shown.", cancelled: "Task cancelled",
      failed: "The task could not complete", needs_review: "The task environment could not be confirmed closed; review is required.",
    },
    errors: model => ({
      asset_missing: "Required CLI files were not found.", asset_invalid: "CLI files could not be verified.", docker_unavailable: "Docker is unavailable. Start Docker and try again.",
      image_missing: "The required runtime image was not found. Complete environment setup and try again.", profile_invalid: "The profile could not be verified. Refresh profiles and try again.",
      profile_needs_review: "The profile environment requires review.",
      profile_unbound: "This profile has no connected account environment. Connect the account in the panel above.",
      auth_required: "Sign in to the official CLI account. Connect the account in the panel above.",
      model_unavailable: `The cheap test model (${model}) was unavailable. Nothing fell back to a paid or default model; the task did not run.`,
      quota_exhausted: "Your subscription usage limit was reached. Try again after the limit resets.",
      provider_failed: "The provider's CLI could not complete the task.", tool_limit: `The agent reached the limit of ${taskRunMaxToolCalls} tool calls.`,
      candidate_invalid: "The agent's change could not be read as a valid fix.", candidate_rejected: "The independent verifier rejected the candidate.",
      verifier_failed: "The independent verifier could not run.", worker_failed: "The task operation could not complete.", cleanup_failed: "The task environment could not close.",
      deadline_exceeded: "The task reached its 20 minute time limit.", cancelled: "Task cancelled.",
    }),
  },
};

const short = (hash: string) => `${hash.slice(0, 12)}…`;
function diffClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "task-run-diff-meta";
  if (line.startsWith("@@")) return "task-run-diff-hunk";
  if (line.startsWith("+")) return "task-run-diff-add";
  if (line.startsWith("-")) return "task-run-diff-del";
  return "task-run-diff-context";
}
function DiffView({patch, label}: {patch: string; label: string}) {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  // Lines are rendered as plain text; the patch is never interpreted as markup.
  return <pre className="task-run-diff" tabIndex={0} aria-label={label} data-testid="task-run-diff">
    {lines.map((line, index) => <span key={index} className={"task-run-diff-line " + diffClass(line)}>{line || " "}</span>)}
  </pre>;
}

// The deadline of a run is 1200 s; observation stops slightly after it.
const pollLimit = 1300;

export function TaskRunPanel({language, profile}: {language: "tr" | "en"; profile: ManagedProfile}) {
  const t = words[language];
  const requestedModel = taskRunRequestedModels[profile.provider];
  const [status, setStatus] = useState<TaskRunStatus | null>(null);
  const [pending, setPending] = useState<"read" | "start" | "cancel" | null>("read");
  const [error, setError] = useState(false);
  const [paused, setPaused] = useState(false);
  const [approved, setApproved] = useState(false);
  const [copy, setCopy] = useState<"copied" | "failed" | null>(null);
  const snapshot = useRef<TaskRunStatus | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const pollCount = useRef(0);
  const pollStarted = useRef(Date.now());

  async function cancelWithResync(operation: TaskRunOperation, signal: AbortSignal) {
    try {
      return await cancelTaskRun({schema_version: "1.0", request_id: operation.request_id, expected_revision: operation.revision}, signal);
    } catch (failure) {
      if (signal.aborted) throw failure;
      // Revisions advance with every tool call; resynchronize once and retry against the same request only.
      const latest = await readTaskRun(signal), current = latest.operation;
      if (latest.availability !== "available" || !current || current.request_id !== operation.request_id ||
        current.profile_id !== operation.profile_id) throw failure;
      if (current.phase === "finished") return latest;
      if (current.revision === operation.revision) throw failure;
      return cancelTaskRun({schema_version: "1.0", request_id: current.request_id, expected_revision: current.revision}, signal);
    }
  }
  async function observe(kind: "read" | "start" | "cancel") {
    if (mutation.current) return;
    const before = snapshot.current;
    const operation = before?.operation;
    if (kind === "start" && (!before || before.availability !== "available" || !approved ||
      operation && (operation.phase !== "finished" || operation.outcome === "needs_review"))) return;
    if (kind === "cancel" && (!operation || operation.profile_id !== profile.profile_id || operation.phase === "finished" || operation.phase === "cleaning")) return;
    if (kind !== "read") mutation.current = true;
    if (kind === "start") setApproved(false);
    waiting.current?.abort();
    const controller = new AbortController(); waiting.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    setPending(kind);
    try {
      const checked = kind === "start"
        ? await startTaskRun({schema_version: "1.0", request_id: crypto.randomUUID(), profile_id: profile.profile_id, task_id: "controlled-sum-integers-v1", approved: true}, controller.signal)
        : kind === "cancel" ? await cancelWithResync(operation!, controller.signal)
          : await readTaskRun(controller.signal);
      if (waiting.current !== controller || controller.signal.aborted) return;
      const incoming = checked.operation;
      if (incoming?.profile_id === profile.profile_id && incoming.provider !== profile.provider) throw new Error("task_run_contract_invalid");
      const next = acceptTaskRunUpdate(before, checked);
      snapshot.current = next; setStatus(next); setError(false);
      if (incoming?.request_id !== operation?.request_id) setCopy(null);
      // Approval covers one run only.
      if (incoming && incoming.phase !== "finished" || kind === "start") setApproved(false);
      if (kind !== "read" || operation?.request_id !== incoming?.request_id) { pollCount.current = 0; pollStarted.current = Date.now(); setPaused(false); }
    } catch {
      if (waiting.current === controller) { setError(true); setPaused(true); }
    } finally {
      window.clearTimeout(timeout);
      if (waiting.current === controller) { waiting.current = null; mutation.current = false; setPending(null); }
    }
  }
  function refresh() { pollCount.current = 0; pollStarted.current = Date.now(); setPaused(false); void observe("read"); }
  // Leaving the panel only stops observation; the native-owned run continues.
  useEffect(() => {
    void observe("read");
    return () => { waiting.current?.abort(); waiting.current = null; mutation.current = false; snapshot.current = null; };
  }, []);
  const operation = status?.operation;
  const active = !!operation && operation.phase !== "finished";
  const ours = operation?.profile_id === profile.profile_id;
  useEffect(() => {
    if (!active || pending || paused || error) return;
    if (pollCount.current >= pollLimit || Date.now() - pollStarted.current >= pollLimit * 1000) { setPaused(true); return; }
    const timeout = window.setTimeout(() => { pollCount.current++; void observe("read"); }, 1000);
    return () => window.clearTimeout(timeout);
  }, [active, status, pending, paused, error]);
  const blocked = status?.availability !== "available" || active || !!pending || error || operation?.outcome === "needs_review";
  const finished = ours && operation.phase === "finished" ? operation : null;
  const passedResult = finished?.outcome === "passed" ? finished.result : null;
  const rejectedResult = finished?.outcome === "rejected" ? finished.result : null;
  async function copyDiff() {
    try { await navigator.clipboard.writeText(passedResult!.patch!); setCopy("copied"); }
    catch { setCopy("failed"); }
  }
  const phaseText = ours && active ? t.phases[operation.phase as Exclude<TaskRunPhase, "finished">] : null;
  return <section className="task-run-panel" aria-labelledby="task-run-title" aria-busy={pending !== null}>
    <div className="section-heading"><h3 id="task-run-title">{t.title}</h3>{taskRunNative() && <button className="secondary-button" disabled={pending === "start" || pending === "cancel"} onClick={refresh}>{t.refresh}</button>}</div>
    <p>{t.description}</p>
    <div className="task-run-card">
      <h4>{t.cardTitle}</h4>
      <p>{t.cardText}</p>
      <dl>
        <div><dt>{t.model}</dt><dd><code>{requestedModel}</code></dd></div>
        <div><dt>{t.limitsTitle}</dt><dd><ul>{t.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></dd></div>
      </dl>
      <p className="task-run-quota">{t.quota}</p>
    </div>
    <label className="task-run-approval">
      <input type="checkbox" checked={approved} disabled={blocked} onChange={event => setApproved(event.target.checked)} />
      <span>{t.approve}</span>
    </label>
    <div className="cli-check-actions">
      <button className="primary-button" disabled={blocked || !approved} onClick={() => void observe("start")}>{t.start}</button>
      {ours && active && <button className="secondary-button" disabled={!!pending || operation.phase === "cleaning"} onClick={() => void observe("cancel")}>{t.cancel}</button>}
    </div>
    {status?.availability === "unavailable" && <p role="status">{t.unavailable}</p>}
    {pending === "read" && !status && <p role="status">{t.loading}</p>}
    {pending === "start" && <p role="status">{t.submitting}</p>}
    {pending === "cancel" && <p role="status">{t.cancelPending}</p>}
    {error && <p role="alert">{t.error}</p>}
    {!ours && active && <p role="status">{t.otherProfile}</p>}
    {!ours && operation?.outcome === "needs_review" && <p role="status">{t.otherReview}</p>}
    {ours && active && <div className="task-run-progress" role="status">
      <strong>{phaseText}</strong>
      <span>{t.toolCalls}: {operation.tool_calls} / {taskRunMaxToolCalls}</span>
      {operation.model.observed && <span>{t.observed}: <code>{operation.model.observed}</code></span>}
    </div>}
    {finished && <div className="cli-check-result task-run-result" role="status">
      <strong>{t.outcomes[finished.outcome!]}</strong>
      {finished.error_code && finished.error_code !== "cancelled" && finished.error_code !== "candidate_rejected" && <p>{t.errors(requestedModel)[finished.error_code]}</p>}
      {finished.tool_calls > 0 && <span>{t.toolCalls}: {finished.tool_calls} / {taskRunMaxToolCalls}</span>}
      {finished.model.observed && <span>{t.observed}: <code>{finished.model.observed}</code></span>}
      {(passedResult || rejectedResult) && <p>{t.verifier}: {passedResult
        ? t.verifierPassed(passedResult.verifier.cases)
        : t.verifierRejected(rejectedResult!.verifier.cases, rejectedResult!.verifier.json_cases_passed, rejectedResult!.verifier.sparse_cases_passed)}</p>}
    </div>}
    {passedResult && <div className="task-run-verified">
      <dl className="task-run-hashes">
        <div><dt>{t.candidate}</dt><dd><code title={passedResult.candidate_sha256} aria-label={passedResult.candidate_sha256}>{short(passedResult.candidate_sha256)}</code></dd></div>
        <div><dt>{t.patch}</dt><dd><code title={passedResult.patch_sha256!} aria-label={passedResult.patch_sha256!}>{short(passedResult.patch_sha256!)}</code></dd></div>
      </dl>
      <DiffView patch={passedResult.patch!} label={t.diff} />
      <div className="cli-check-actions">
        <button className="secondary-button" onClick={() => void copyDiff()}>{t.copy}</button>
        {copy && <span role="status">{copy === "copied" ? t.copied : t.copyFailed}</span>}
      </div>
    </div>}
    {paused && active && !error && <p role="status">{t.paused}</p>}
  </section>;
}
