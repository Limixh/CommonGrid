import { useEffect, useState } from "react";
import { runLimitsNative } from "./run-limits-client";
import { useRunLimits } from "./useRunLimits";
import type { Settings } from "./ui-types";

const defaults: Settings = {
  language: "tr",
  cpu: 2,
  memoryMb: 4096,
  taskMinutes: 30,
  dailyMinutes: 120,
  concurrency: 1,
};
export function settingsValid(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  const s = value as Settings;
  return (
    ["tr", "en"].includes(s.language) &&
    Object.entries({
      cpu: [1, 64],
      memoryMb: [256, 262144],
      taskMinutes: [1, 1440],
      dailyMinutes: [1, 1440],
      concurrency: [1, 8],
    }).every(
      ([key, [min, max]]) =>
        Number.isInteger(s[key as keyof Settings]) &&
        Number(s[key as keyof Settings]) >= min &&
        Number(s[key as keyof Settings]) <= max,
    ) &&
    s.taskMinutes <= s.dailyMinutes
  );
}
function loadSettings() {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem("commongrid.settings.v1") ?? "null",
    );
    return settingsValid(stored) ? stored : defaults;
  } catch {
    return defaults;
  }
}

export function useContributionSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [draft, setDraft] = useState<Settings>(settings);
  const [notice, setNotice] = useState("");
  const limits = useRunLimits();
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);
  // The native ledger owns the time limits: when it answers, it wins over a
  // drifted browser copy. A fail-closed answer carries defaults and is ignored.
  useEffect(() => {
    const native = limits.status;
    if (!native || native.availability !== "available" || native.effective.reason === "local_budget_unavailable") return;
    const taskMinutes = Math.floor(native.limits.attempt_sec / 60), dailyMinutes = Math.floor(native.limits.daily_sec / 60);
    const hydrate = (current: Settings): Settings => current.taskMinutes === taskMinutes && current.dailyMinutes === dailyMinutes && current.concurrency === 1
      ? current : {...current, taskMinutes, dailyMinutes, concurrency: 1};
    setSettings(hydrate);
    setDraft(hydrate);
  }, [limits.status]);
  async function save() {
    if (!settingsValid(draft)) {
      setNotice("invalid");
      return;
    }
    let next = draft;
    if (runLimitsNative()) {
      // Native first: a rejected native save must not leave a local copy that disagrees with enforcement.
      next = {...draft, concurrency: 1};
      if (!(await limits.save(next.taskMinutes * 60, next.dailyMinutes * 60))) {
        setNotice("native");
        return;
      }
    }
    try {
      localStorage.setItem("commongrid.settings.v1", JSON.stringify(next));
      setSettings(next);
      setDraft(next);
      setNotice("saved");
    } catch {
      setNotice("storage");
    }
  }

  function toggleLanguage() {
    const next = {
      ...settings,
      language: settings.language === "tr" ? "en" : "tr",
    } as Settings;
    setDraft(next);
    setSettings(next);
    try {
      localStorage.setItem(
        "commongrid.settings.v1",
        JSON.stringify(next),
      );
    } catch {
      /* Session language still changes. */
    }

  }
  return { settings, draft, setDraft, notice, setNotice, save, toggleLanguage };
}
