import type { ExecutionSelection } from "./execution-selection";

const words = {
  tr: {
    controlled: "Seçilen yerel görev", catalog: "Seçilen katalog görevi", title: "Kontrollü doğrulama görevi: sum.mjs",
    local: "Bu yerel görev sum.mjs düzeltmesini 34 örnekle doğrular. Çalıştırmak için bir profil seç, hesabını bağla ve aşağıdaki görev onayını ver.",
    unsupported: "Bu katalog görevi henüz çalıştırılamıyor.",
    explanation: "Seçtiğin görev ve yaklaşım burada korunur. Profilini hazırlayabilirsin; katalog görevleri için çalışma alanı ve doğrulayıcı desteği henüz hazır değil.",
    choose: "Kontrollü görevi seç", separate: "Yerel sum.mjs görevini seçmek, seçilen katalog görevini değiştirmez veya tamamlamaz.",
    id: "Görev kimliği", type: "Tür", kind: "Görev türü", version: "Sürüm", hash: "Sözleşme SHA-256", commit: "Temel commit", strategy: "Seçilen yaklaşım",
  },
  en: {
    controlled: "Selected local task", catalog: "Selected catalog task", title: "Controlled verification task: sum.mjs",
    local: "This local task verifies a sum.mjs fix with 34 cases. Select a profile, connect its account, and approve the task below to run it.",
    unsupported: "This catalog task cannot run yet.",
    explanation: "Your selected task and strategy are preserved here. You can prepare your profile; workspace and verifier support for catalog tasks is not ready yet.",
    choose: "Select controlled task", separate: "Selecting the local sum.mjs task does not change or complete the selected catalog task.",
    id: "Task ID", type: "Type", kind: "Task kind", version: "Version", hash: "Contract SHA-256", commit: "Base commit", strategy: "Selected strategy",
  },
};

export function ExecutionSelectionPanel({language, selection, onSelectControlled}: {
  language: "tr" | "en"; selection: ExecutionSelection; onSelectControlled: () => void;
}) {
  const t = words[language];
  const task = selection.kind === "catalog" ? selection.task : null;
  return <section className="execution-selection-panel" data-selection-kind={selection.kind} data-testid="execution-selection" aria-labelledby="execution-selection-title">
    <h3 id="execution-selection-title">{task ? t.catalog : t.controlled}</h3>
    <h4>{task ? task.title : t.title}</h4>
    {task ? <>
      <dl>
        {[[t.id, task.id], [t.type, task.type], [t.kind, task.kind], [t.version, String(task.task_version)],
          [t.hash, task.contract_hash], [t.commit, task.base_commit], [t.strategy, task.strategy_id]].map(([label, value]) =>
          <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
      </dl>
      <p role="status"><strong>{t.unsupported}</strong></p>
      <p>{t.explanation}</p>
      <p className="muted-note">{t.separate}</p>
      <button className="secondary-button" onClick={onSelectControlled}>{t.choose}</button>
    </> : <><code>{selection.kind === "controlled" && selection.task_id}</code><p>{t.local}</p></>}
  </section>;
}
