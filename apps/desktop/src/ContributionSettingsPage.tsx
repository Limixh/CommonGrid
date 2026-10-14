import { useEffect, type Dispatch, type SetStateAction } from "react";
import { Icon } from "./Icon";
import type { UIWords } from "./language";
import { runLimitsNative } from "./run-limits-client";
import type { Settings } from "./ui-types";
import { useRunLimits } from "./useRunLimits";

type ContributionSettingsPageProps = { draft: Settings; setDraft: Dispatch<SetStateAction<Settings>>; notice: string; setNotice: Dispatch<SetStateAction<string>>; save: () => void; t: UIWords };

const minutes = (seconds: number) => Math.floor(seconds / 60);

export function ContributionSettingsPage({ draft, setDraft, notice, setNotice, save, t }: ContributionSettingsPageProps) {
  const native = runLimitsNative();
  const limits = useRunLimits();
  // A completed save changes the ledger view (limits and remaining time).
  useEffect(() => { if (notice === "saved" && native) void limits.refresh(); }, [notice]);
  const ledger = limits.status?.availability === "available" && limits.status.effective.reason !== "local_budget_unavailable" ? limits.status : null;
  return (
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
                    value={key === "concurrency" && native ? 1 : Number.isFinite(draft[key]) ? draft[key] : ""}
                    disabled={key === "concurrency" && native}
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
        {native && <p className="muted-note" data-testid="concurrency-fixed">{t.concurrencyFixed}</p>}
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
        {native && <p className="muted-note" role="note" data-testid="run-limits-usage">
          {ledger
            ? `${t.limitsUsage}: ${minutes(ledger.usage.used_sec + ledger.usage.open_sec)} ${t.min} · ${t.limitsRemaining}: ${minutes(ledger.usage.remaining_sec)} ${t.min}. ${t.limitsNote}`
            : limits.pending ? "" : t.limitsUnreadable}
        </p>}
        <div className="paid-note">
          <Icon name="lock" size={20} />
          <div>
            <strong>{t.paid}</strong>
            <p>{t.paidText}</p>
          </div>
        </div>
        <div className="save-row">
          <button type="submit" className="primary-button" disabled={notice === "saving"} aria-busy={notice === "saving"}>
            <Icon name="check" size={17} />
            {t.save}
          </button>
          {notice && notice !== "saving" && (
            <span
              role="status"
              className={
                notice === "saved" ? "saved-message" : "error-message"
              }
            >
              {notice === "native" ? t.nativeFailed : notice === "storage"
                ? "Local storage unavailable"
                : t[notice as "saved" | "invalid" | "nativeFailed"]}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
