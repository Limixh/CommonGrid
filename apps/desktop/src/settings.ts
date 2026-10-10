import { useEffect, useState } from "react";
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
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);
  function save() {
    if (!settingsValid(draft)) {
      setNotice("invalid");
      return;
    }
    try {
      localStorage.setItem("commongrid.settings.v1", JSON.stringify(draft));
      setSettings(draft);
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
