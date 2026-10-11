import { useEffect, useRef, useState } from "react";
import {
  acceptManagedProfilesUpdate, managedProfileNameValid,
  type ManagedProfileCreate, type ManagedProfileProvider, type ManagedProfilesStatus,
} from "@commongrid/agent-adapters/managed-profiles";
import { createManagedProfile, managedProfilesNative, readManagedProfiles, selectManagedProfile } from "./managed-profile-client";
import { ProfileSessionPanel } from "./ProfileSessionPanel";

const words = {
  tr: {
    title: "Ajan profillerin", description: "Claude Code veya Codex için profil oluştur. Seçili profilin hesap bağlantısını aşağıdaki panelden yönet.",
    name: "Profil adı", provider: "Ajan", create: "Profil oluştur", refresh: "Profilleri yenile", select: "Bu profili seç", selected: "Seçili profil",
    loading: "Profiller okunuyor…", saving: "Profil kaydediliyor…", empty: "Henüz bir ajan profili oluşturmadın.",
    unavailable: "Profil oluşturma ve seçme masaüstü uygulamasında kullanılabilir.",
    error: "Profil bilgileri doğrulanamadı. Son durumu yenileyip tekrar dene.", invalid: "Geçerli, kısa bir profil adı gir.",
    limit: "Bu cihazdaki 16 profil sınırına ulaştın.", saved: "Kaydedilmiş profil", retry: "Aynı kaydı tekrar dene",
  },
  en: {
    title: "Your agent profiles", description: "Create a profile for Claude Code or Codex. Manage the selected profile's account connection in the panel below.",
    name: "Profile name", provider: "Agent", create: "Create profile", refresh: "Refresh profiles", select: "Select this profile", selected: "Selected profile",
    loading: "Reading profiles…", saving: "Saving profile…", empty: "You have not created an agent profile yet.",
    unavailable: "Profile creation and selection are available in the desktop application.",
    error: "Profile information could not be validated. Refresh the latest status and try again.", invalid: "Enter a valid, short profile name.",
    limit: "This device has reached its limit of 16 profiles.", saved: "Saved profile", retry: "Retry the same profile",
  },
};
export function ManagedProfilesPanel({language}: {language: "tr" | "en"}) {
  const t = words[language];
  const [status, setStatus] = useState<ManagedProfilesStatus | null>(null);
  const [pending, setPending] = useState<"read" | "create" | "select" | null>("read");
  const [error, setError] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ManagedProfileProvider>("codex");
  const [retry, setRetry] = useState(false);
  const snapshot = useRef<ManagedProfilesStatus | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const uncertainCreate = useRef<ManagedProfileCreate | null>(null);

  async function observe(kind: "read" | "create" | "select", profileId?: string) {
    if (mutation.current) return;
    const before = snapshot.current;
    if (kind !== "read" && (!before || before.availability !== "available")) return;
    if (kind === "create" && !uncertainCreate.current && !managedProfileNameValid(name.trim())) { setInvalid(true); return; }
    if (kind !== "read") mutation.current = true;
    waiting.current?.abort();
    const controller = new AbortController(); waiting.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    setPending(kind); setInvalid(false);
    try {
      let checked: ManagedProfilesStatus;
      if (kind === "create") {
        uncertainCreate.current ??= {schema_version: "1.0", request_id: crypto.randomUUID(), provider, name: name.trim(), expected_revision: before!.revision};
        checked = await createManagedProfile(uncertainCreate.current, controller.signal);
      } else if (kind === "select") {
        checked = await selectManagedProfile({schema_version: "1.0", profile_id: profileId!, expected_revision: before!.revision}, controller.signal);
      } else checked = await readManagedProfiles(controller.signal);
      if (waiting.current !== controller || controller.signal.aborted) return;
      const next = acceptManagedProfilesUpdate(before, checked);
      snapshot.current = next; setStatus(next); setError(false);
      const candidate = uncertainCreate.current;
      if (candidate && next.profiles.some(profile => profile.profile_id === candidate.request_id && profile.provider === candidate.provider && profile.name === candidate.name)) {
        uncertainCreate.current = null; setRetry(false); setName("");
      } else {
        if (candidate && next.availability === "available" && !next.profiles.some(profile => profile.profile_id === candidate.request_id)) {
          uncertainCreate.current = {...candidate, expected_revision: next.revision};
        }
        setRetry(!!candidate);
      }
    } catch {
      if (waiting.current === controller) { setError(true); setRetry(!!uncertainCreate.current); }
    } finally {
      window.clearTimeout(timeout);
      if (waiting.current === controller) { waiting.current = null; mutation.current = false; setPending(null); }
    }
  }
  useEffect(() => {
    void observe("read");
    return () => { waiting.current?.abort(); waiting.current = null; mutation.current = false; };
  }, []);
  const available = status?.availability === "available";
  const full = (status?.profiles.length ?? 0) >= 16;
  const enabled = available && !pending && !error;
  const selectedProfile = available ? status.profiles.find(profile => profile.profile_id === status.selected_profile_id) : undefined;
  return <section className="settings-box managed-profiles-panel" aria-labelledby="managed-profiles-title" aria-busy={pending !== null}>
    <div className="section-heading"><h2 id="managed-profiles-title">{t.title}</h2>{managedProfilesNative() && <button className="secondary-button" disabled={pending === "create" || pending === "select"} onClick={() => void observe("read")}>{t.refresh}</button>}</div>
    <p>{t.description}</p>
    {status?.availability === "unavailable" && <p role="status">{t.unavailable}</p>}
    {pending === "read" && !status && <p role="status">{t.loading}</p>}
    {error && <p role="alert">{t.error}</p>}
    <form className="managed-profile-form" onSubmit={event => { event.preventDefault(); void observe("create"); }}>
      <label>{t.name}<input value={name} disabled={!enabled || retry} onChange={event => setName(event.target.value)} autoComplete="off" maxLength={96} /></label>
      <label>{t.provider}<select aria-label={t.provider} value={provider} disabled={!enabled || retry} onChange={event => setProvider(event.target.value as ManagedProfileProvider)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
      <button className="secondary-button" disabled={!enabled || (full && !retry)} type="submit">{retry ? t.retry : t.create}</button>
    </form>
    {invalid && <p role="alert">{t.invalid}</p>}
    {full && <p role="status">{t.limit}</p>}
    {(pending === "create" || pending === "select") && <p role="status">{t.saving}</p>}
    {available && status.profiles.length === 0 && <p>{t.empty}</p>}
    {available && <ul className="managed-profile-list">{status.profiles.map(profile => <li key={profile.profile_id}>
      <div><strong>{profile.name}</strong><span>{profile.provider === "codex" ? "Codex" : "Claude Code"} · {t.saved}</span></div>
      {status.selected_profile_id === profile.profile_id ? <strong className="managed-profile-selected">{t.selected}</strong> :
        <button className="secondary-button" disabled={!enabled || retry} onClick={() => void observe("select", profile.profile_id)}>{t.select}</button>}
    </li>)}</ul>}
    {selectedProfile && <ProfileSessionPanel key={selectedProfile.profile_id} language={language} profile={selectedProfile} />}
  </section>;
}
