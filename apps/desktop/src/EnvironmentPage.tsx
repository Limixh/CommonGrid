import { useEffect, useState, type ReactNode } from "react";
import { CliCheckPanel } from "./CliCheckPanel";
import { OperationRecoveryPanel } from "./OperationRecoveryPanel";
import { Icon } from "./Icon";
import { words, type Language } from "./language";
import type { Doctor } from "./ui-types";

export function useEnvironmentReadiness() {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
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
  return { doctor, loadDoctor };
}

type EnvironmentPageProps = { language: Language; doctor: Doctor | null; loadDoctor: () => Promise<void>; managedProfiles?: ReactNode };

export function EnvironmentPage({ language, doctor, loadDoctor, managedProfiles }: EnvironmentPageProps) {
  const t = words[language];
  return (
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
              language,
            )}
          </p>
        </>
      ) : (
        <div className="empty-state">{t.noReport}</div>
      )}
      <CliCheckPanel language={language} />
      {managedProfiles}
      <div className="isolation-card">
        <Icon name="lock" size={26} />
        <div>
          <span className="eyebrow">{t.identity}</span>
          <h2>{t.notEvaluated}</h2>
          <p>{t.nextText}</p>
          <code>npm run doctor</code>
        </div>
      </div>
      <OperationRecoveryPanel language={language} />
    </div>
  );
}
