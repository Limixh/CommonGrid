export type Project = { id: string; title: string; type: string; description: string };
export type Check = {
  id: string;
  label: string;
  state: "available" | "missing" | "not_running";
  version: string | null;
};
export type Doctor = { checked_at: string; checks: Check[]; isolation_gate: string };
export type Settings = {
  language: "tr" | "en";
  cpu: number;
  memoryMb: number;
  taskMinutes: number;
  dailyMinutes: number;
  concurrency: number;
};

export type Page = "workspace" | "agents" | "settings" | "account" | "contributions";
