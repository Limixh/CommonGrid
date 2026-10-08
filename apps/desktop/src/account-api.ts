import { useCallback, useEffect, useRef, useState } from "react";

export type Provider = { id: "github" | "google"; enabled: boolean };
export type Session = {
  authenticated: true;
  user: { id: string; display_name: string; provider: "github" | "google" };
  csrf_token: string;
  expires_at: string;
};
export type AccountState =
  | { status: "loading" | "guest" | "error" | "expired"; session?: never }
  | { status: "authenticated"; session: Session };
export class AccountExpired extends Error {}
export function boundedText(value: unknown, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error("Unexpected account response");
  return value;
}
export async function accountJSON(path: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, credentials: "same-origin", signal });
  if (response.status === 401) throw new AccountExpired();
  if (!response.ok) throw new Error("Account unavailable");
  return response.status === 204 ? null : response.json();
}
function readSession(value: unknown): Session | null {
  if (!value || typeof value !== "object") throw new Error("Unexpected session");
  if ((value as { authenticated?: unknown }).authenticated === false) return null;
  const data = value as Session;
  if (data.authenticated !== true || !data.user || !["github", "google"].includes(data.user.provider))
    throw new Error("Unexpected session");
  boundedText(data.user.id); boundedText(data.user.display_name, 320); boundedText(data.csrf_token, 512);
  boundedText(data.expires_at, 64);
  if (!Number.isFinite(Date.parse(data.expires_at))) throw new Error("Unexpected expiry");
  return { authenticated: true, user: { id: data.user.id, display_name: data.user.display_name, provider: data.user.provider }, csrf_token: data.csrf_token, expires_at: data.expires_at };
}
export function useAccount() {
  const [state, setState] = useState<AccountState>({ status: "loading" });
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const expire = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setState({ status: "expired" });
    setLogoutPending(false);
    setLogoutError(false);
  }, []);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setState({ status: "loading" }); setLogoutError(false);
    try {
      const results = await Promise.allSettled([
        accountJSON("/api/v1/auth/session", controller.signal),
        accountJSON("/api/v1/auth/providers", controller.signal),
      ]);
      if (active.current !== controller) return;
      if (results[1].status === "fulfilled") {
        const raw = results[1].value;
        if (!Array.isArray(raw?.providers) || raw.providers.length > 2 || raw.providers.some((p: Provider) => !p || !["github", "google"].includes(p.id) || typeof p.enabled !== "boolean") || new Set(raw.providers.map((p: Provider) => p.id)).size !== raw.providers.length)
          setProviders(null);
        else setProviders(raw.providers.map((p: Provider) => ({ id: p.id, enabled: p.enabled })));
      } else setProviders(null);
      if (results[0].status === "rejected") throw results[0].reason;
      const session = readSession(results[0].value);
      setState(session ? (Date.parse(session.expires_at) <= Date.now() ? { status: "expired" } : { status: "authenticated", session }) : { status: "guest" });
    } catch (error) {
      if (active.current === controller)
        setState({ status: error instanceof AccountExpired ? "expired" : "error" });
    } finally { window.clearTimeout(timeout); }
  }, []);
  useEffect(() => { void refresh(); return () => { active.current?.abort(); active.current = null; }; }, [refresh]);
  useEffect(() => {
    if (state.status !== "authenticated") return;
    const expires = Date.parse(state.session.expires_at);
    let timeout: number;
    const schedule = () => {
      const remaining = expires - Date.now();
      if (remaining <= 0) expire();
      else timeout = window.setTimeout(schedule, Math.min(2_147_483_647, remaining));
    };
    schedule();
    return () => window.clearTimeout(timeout);
  }, [state, expire]);
  async function logout() {
    if (state.status !== "authenticated" || logoutPending) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setLogoutPending(true); setLogoutError(false);
    try {
      await accountJSON("/api/v1/auth/logout", controller.signal, { method: "POST", headers: { "X-CSRF-Token": state.session.csrf_token } });
      if (active.current === controller) setState({ status: "guest" });
    } catch (error) {
      if (active.current === controller) {
        if (error instanceof AccountExpired) expire();
        else setLogoutError(true);
      }
    } finally {
      window.clearTimeout(timeout);
      if (active.current === controller) setLogoutPending(false);
    }
  }
  return { state, providers, refresh, expire, logout, logoutPending, logoutError };
}
export type Account = ReturnType<typeof useAccount>;
