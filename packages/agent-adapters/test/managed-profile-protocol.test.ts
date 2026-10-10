import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptManagedProfilesUpdate, managedProfileNameValid, validateManagedProfileCreate, validateManagedProfileSelect,
  validateManagedProfilesStatus, unavailableManagedProfiles, type ManagedProfilesStatus,
} from "../src/managed-profile-protocol.ts";
const id = "a0000000-0000-4000-8000-000000000001";
const other = "a0000000-0000-4000-8000-000000000002";
const empty: ManagedProfilesStatus = {schema_version: "1.0", availability: "available", revision: 0, profiles: [], selected_profile_id: null};
const created: ManagedProfilesStatus = {...empty, revision: 1, profiles: [{profile_id: id, provider: "codex", name: "İlk ajan"}]};
test("profile requests admit public metadata only and enforce UTF-8 name limits", () => {
  const create = {schema_version: "1.0", request_id: id, provider: "codex", name: "İlk ajan", expected_revision: 0};
  assert.deepEqual(validateManagedProfileCreate(create), create);
  const select = {schema_version: "1.0", profile_id: id, expected_revision: 1};
  assert.deepEqual(validateManagedProfileSelect(select), select);
  for (const value of [{...create, auth_path: "PRIVATE"}, {...create, owner: id}, {...create, provider: "api"}, {...create, request_id: "../profile"}, {...create, expected_revision: -1}, {...create, expected_revision: 1.5}, {...create, name: "a\nPRIVATE"}, {...create, name: " x "}, {...create, name: "😀".repeat(25)}, {...create, name: "\ud800"}]) assert.throws(() => validateManagedProfileCreate(value));
  for (const value of [{...select, argv: []}, {...select, profile_id: "invalid"}, {...select, expected_revision: 1_000_000_001}]) assert.throws(() => validateManagedProfileSelect(value));
  assert.equal(managedProfileNameValid("😀".repeat(24)), true);
  assert.equal(managedProfileNameValid("\u0085"), false);
});
test("profile status rejects duplicates, unknown selected identities and unprojected auth fields", () => {
  assert.deepEqual(validateManagedProfilesStatus(created), created);
  assert.deepEqual(validateManagedProfilesStatus(unavailableManagedProfiles()), unavailableManagedProfiles());
  for (const availability of [["available"], ["unavailable"], {}, null, true]) assert.throws(() => validateManagedProfilesStatus({...empty, availability}));
  for (const value of [{...created, profiles: [...created.profiles, ...created.profiles]}, {...created, selected_profile_id: other}, {...created, authenticated: true}, {...created, availability: "unavailable"}, {...created, profiles: [{...created.profiles[0], token: "PRIVATE"}]}, {...empty, profiles: Array.from({length: 17}, (_, index) => ({profile_id: `a0000000-0000-4000-8000-${String(index).padStart(12,"0")}`, provider: "codex", name: "Profile"}))}]) assert.throws(() => validateManagedProfilesStatus(value));
  const result = validateManagedProfilesStatus(created); result.profiles[0].name = "changed";
  assert.equal(created.profiles[0].name, "İlk ajan");
});
test("profile observations reject rollback and equal-revision changes without depending on JSON key order", () => {
  const selected = {...created, revision: 2, selected_profile_id: id};
  assert.deepEqual(acceptManagedProfilesUpdate(created, selected), selected);
  assert.deepEqual(acceptManagedProfilesUpdate(created, {selected_profile_id: null, profiles: [{name: "İlk ajan", provider: "codex", profile_id: id}], revision: 1, availability: "available", schema_version: "1.0"}), created);
  for (const value of [empty, unavailableManagedProfiles(), {...created, selected_profile_id: id}, {...created, profiles: [{...created.profiles[0], provider: "claude"}]}]) assert.throws(() => acceptManagedProfilesUpdate(created, value));
});
