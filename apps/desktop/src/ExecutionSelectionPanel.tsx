import { runnableTaskId, type ExecutionSelection } from "./execution-selection";

const words = {
  tr: {
    controlled: "Seçilen yerel görev", catalog: "Seçilen katalog görevi", title: "Kontrollü doğrulama görevi: sum.mjs",
    central: "Bu görev merkezi süre bütçesine ayrılarak çalıştırılabilir.", centralUnavailable: "Bu görev için merkezi çalıştırma yeteneği sunulmuyor. Görev başlatılamaz.",
    centralText: "Başlatınca hesabın için süre ayrılır ve görev izole yerel ortamda çalışır. Doğrulanmış sonucu inceleyip Gönder düğmesiyle merkeze teslim edebilirsin. Merkezi teslim kendi başına görevin kabul edildiği anlamına gelmez.",
    local: "Bu yerel görev sum.mjs düzeltmesini 34 örnekle doğrular. Çalıştırmak için bir profil seç, hesabını bağla ve aşağıdaki görev onayını ver.",
    unsupported: "Bu katalog görevi henüz çalıştırılamıyor.",
    runnable: "Bu katalog görevi yerelde çalıştırılabilir.",
    runnableText: "Görev, depo klonlanmadan sabitlenmiş yerel bir kaynak paketinden çalışır. Seçtiğin onaylı yaklaşım bu çalıştırmaya uygulanır; yönergeleri sabitlenmiş sözleşmeden gelir. Yaklaşımı değiştirirsen görevi yeniden hazırlaman ve onaylaman gerekir. Başlatmak için bir profil seç, hesabını bağla ve aşağıdaki görev onayını ver.",
    explanation: "Seçtiğin görev ve yaklaşım burada korunur. Profilini hazırlayabilirsin; katalog görevleri için çalışma alanı ve doğrulayıcı desteği henüz hazır değil.",
    choose: "Kontrollü görevi seç", separate: "Yerel sum.mjs görevini seçmek, seçilen katalog görevini değiştirmez veya tamamlamaz.",
    id: "Görev kimliği", type: "Tür", kind: "Görev türü", version: "Sürüm", hash: "Sözleşme SHA-256", commit: "Temel commit", strategy: "Seçilen yaklaşım",
  },
  en: {
    controlled: "Selected local task", catalog: "Selected catalog task", title: "Controlled verification task: sum.mjs",
    central: "This task can run with a central time budget reservation.", centralUnavailable: "Central execution is unavailable for this task. It cannot start.",
    centralText: "Starting reserves time for your account and runs the task in an isolated local environment. Review the verified result and use Submit to deliver it to the coordinator. Delivery alone does not mean the task has been accepted.",
    local: "This local task verifies a sum.mjs fix with 34 cases. Select a profile, connect its account, and approve the task below to run it.",
    unsupported: "This catalog task cannot run yet.",
    runnable: "This catalog task can run locally.",
    runnableText: "The task runs from a pinned local source bundle without cloning a repository. The approved strategy you selected is applied to this run; its instructions come from the pinned contract. If you change the strategy, you must prepare and approve the task again. To start it, select a profile, connect its account, and approve the task below.",
    explanation: "Your selected task and strategy are preserved here. You can prepare your profile; workspace and verifier support for catalog tasks is not ready yet.",
    choose: "Select controlled task", separate: "Selecting the local sum.mjs task does not change or complete the selected catalog task.",
    id: "Task ID", type: "Type", kind: "Task kind", version: "Version", hash: "Contract SHA-256", commit: "Base commit", strategy: "Selected strategy",
  },
};

export function ExecutionSelectionPanel({language, selection, centralRequired = false, centralAvailable = false, onSelectControlled}: {
  language: "tr" | "en"; selection: ExecutionSelection; centralRequired?: boolean; centralAvailable?: boolean; onSelectControlled: () => void;
}) {
  const t = words[language];
  const task = selection.kind === "catalog" ? selection.task : null;
  const runnable = task !== null && runnableTaskId(selection) !== null;
  return <section className="execution-selection-panel" data-selection-kind={selection.kind} data-testid="execution-selection" aria-labelledby="execution-selection-title">
    <h3 id="execution-selection-title">{task ? t.catalog : t.controlled}</h3>
    <h4>{task ? task.title : t.title}</h4>
    {task ? <>
      <dl>
        {[[t.id, task.id], [t.type, task.type], [t.kind, task.kind], [t.version, String(task.task_version)],
          [t.hash, task.contract_hash], [t.commit, task.base_commit], [t.strategy, task.strategy_id]].map(([label, value]) =>
          <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
      </dl>
      <p role="status"><strong>{centralRequired ? runnable && centralAvailable ? t.central : t.centralUnavailable : runnable ? t.runnable : t.unsupported}</strong></p>
      <p>{centralRequired && runnable && centralAvailable ? t.centralText : runnable ? t.runnableText : t.explanation}</p>
      <p className="muted-note">{t.separate}</p>
      <button className="secondary-button" onClick={onSelectControlled}>{t.choose}</button>
    </> : <><code>{selection.kind === "controlled" && selection.task_id}</code><p>{t.local}</p></>}
  </section>;
}
