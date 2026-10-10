// Public profile metadata only. Auth state is observed separately through the official CLI.
export type ManagedProfileProvider = "claude" | "codex";
export interface ManagedProfile { profile_id: string; provider: ManagedProfileProvider; name: string }
export interface ManagedProfilesStatus {
  schema_version: "1.0";
  availability: "available" | "unavailable";
  revision: number;
  profiles: ManagedProfile[];
  selected_profile_id: string | null;
}
export interface ManagedProfileCreate {
  schema_version: "1.0"; request_id: string; provider: ManagedProfileProvider; name: string; expected_revision: number;
}
export interface ManagedProfileSelect { schema_version: "1.0"; profile_id: string; expected_revision: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identity = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000;
const provider = (value: unknown): value is ManagedProfileProvider => value === "claude" || value === "codex";
function exact(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
export function managedProfileNameValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= 96 && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
}
function invalid(): never { throw new Error("managed_profile_contract_invalid"); }
export function validateManagedProfileCreate(value: unknown): ManagedProfileCreate {
  if (!exact(value, ["schema_version", "request_id", "provider", "name", "expected_revision"]) ||
    value.schema_version !== "1.0" || !identity(value.request_id) || !provider(value.provider) ||
    !managedProfileNameValid(value.name) || !revision(value.expected_revision)) invalid();
  return structuredClone(value) as unknown as ManagedProfileCreate;
}
export function validateManagedProfileSelect(value: unknown): ManagedProfileSelect {
  if (!exact(value, ["schema_version", "profile_id", "expected_revision"]) || value.schema_version !== "1.0" ||
    !identity(value.profile_id) || !revision(value.expected_revision)) invalid();
  return structuredClone(value) as unknown as ManagedProfileSelect;
}
export function validateManagedProfilesStatus(value: unknown): ManagedProfilesStatus {
  if (!exact(value, ["schema_version", "availability", "revision", "profiles", "selected_profile_id"]) ||
    value.schema_version !== "1.0" || (value.availability !== "available" && value.availability !== "unavailable") ||
    !revision(value.revision) || !Array.isArray(value.profiles) || value.profiles.length > 16) invalid();
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!exact(profile, ["profile_id", "provider", "name"]) || !identity(profile.profile_id) ||
      ids.has(profile.profile_id) || !provider(profile.provider) || !managedProfileNameValid(profile.name)) invalid();
    ids.add(profile.profile_id);
  }
  if (value.selected_profile_id !== null && (!identity(value.selected_profile_id) || !ids.has(value.selected_profile_id))) invalid();
  if (value.availability === "unavailable" && (value.revision !== 0 || ids.size !== 0 || value.selected_profile_id !== null)) invalid();
  return structuredClone(value) as unknown as ManagedProfilesStatus;
}
export function unavailableManagedProfiles(): ManagedProfilesStatus {
  return {schema_version: "1.0", availability: "unavailable", revision: 0, profiles: [], selected_profile_id: null};
}
export function acceptManagedProfilesUpdate(previous: ManagedProfilesStatus | null, incoming: unknown): ManagedProfilesStatus {
  const next = validateManagedProfilesStatus(incoming);
  if (previous?.availability === "available") {
    if (next.availability !== "available" || next.revision < previous.revision ||
      (next.revision === previous.revision && (next.selected_profile_id !== previous.selected_profile_id ||
        next.profiles.length !== previous.profiles.length || next.profiles.some((profile, index) => {
          const before = previous.profiles[index];
          return profile.profile_id !== before.profile_id || profile.provider !== before.provider || profile.name !== before.name;
        })))) throw new Error("managed_profile_status_stale");
  }
  return next;
}
