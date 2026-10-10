import type { Dispatch, SetStateAction } from "react";
import { Icon } from "./Icon";
import type { UIWords } from "./language";
import type { Settings } from "./ui-types";

type ContributionSettingsPageProps = { draft: Settings; setDraft: Dispatch<SetStateAction<Settings>>; notice: string; setNotice: Dispatch<SetStateAction<string>>; save: () => void; t: UIWords };

export function ContributionSettingsPage({ draft, setDraft, notice, setNotice, save, t }: ContributionSettingsPageProps) {
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
                    value={Number.isFinite(draft[key]) ? draft[key] : ""}
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
        <div className="paid-note">
          <Icon name="lock" size={20} />
          <div>
            <strong>{t.paid}</strong>
            <p>{t.paidText}</p>
          </div>
        </div>
        <div className="save-row">
          <button type="submit" className="primary-button">
            <Icon name="check" size={17} />
            {t.save}
          </button>
          {notice && (
            <span
              role="status"
              className={
                notice === "saved" ? "saved-message" : "error-message"
              }
            >
              {notice === "storage"
                ? "Local storage unavailable"
                : t[notice as "saved" | "invalid"]}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
