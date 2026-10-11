import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptProfileSessionUpdate, unavailableProfileSession, validateProfileSessionCancel,
  validateProfileSessionStart, validateProfileSessionStatus, type ProfileSessionOperation, type ProfileSessionStatus,
} from "../src/profile-session-protocol.ts";

const request = "10000000-0000-4000-8000-000000000001", profile = "20000000-0000-4000-8000-000000000002";
const operation = (changes: Partial<ProfileSessionOperation> = {}): ProfileSessionOperation => ({
  request_id: request, profile_id: profile, provider: "codex", action: "login", revision: 0,
  phase: "starting", outcome: null, session_state: "unknown", challenge: null, error_code: null, cleanup: "pending", ...changes,
});
const status = (changes: Partial<ProfileSessionOperation> = {}): ProfileSessionStatus => ({schema_version: "1.0", availability: "available", operation: operation(changes)});
const challenge = {verification_url: "https://auth.openai.com/codex/device" as const, user_code: "ABCD-12345"};
const done = (changes: Partial<ProfileSessionOperation> = {}) => status({phase: "finished", revision: 4, outcome: "passed", session_state: "authenticated", cleanup: "verified", ...changes});

test("account requests grant only a profile action and revision-scoped cancellation", () => {
  const start = {schema_version: "1.0", request_id: request, profile_id: profile, action: "status"};
  assert.deepEqual(validateProfileSessionStart(start), start);
  assert.deepEqual(validateProfileSessionCancel({schema_version: "1.0", request_id: request, expected_revision: 0}),
    {schema_version: "1.0", request_id: request, expected_revision: 0});
  for (const extra of [{owner: profile}, {provider: "claude"}, {auth_path: "private"}, {command: ["login"]}])
    assert.throws(() => validateProfileSessionStart({...start, ...extra}), /contract_invalid/);
  for (const action of ["refresh", ["status"], null, {}, "status "])
    assert.throws(() => validateProfileSessionStart({...start, action}), /contract_invalid/);
  for (const expected_revision of [-1, 1.5, 1_000_000_001, "1", null])
    assert.throws(() => validateProfileSessionCancel({schema_version: "1.0", request_id: request, expected_revision}), /contract_invalid/);
});

test("account observation rejects private fields, malformed wrappers and enum coercion", () => {
  assert.deepEqual(validateProfileSessionStatus(unavailableProfileSession()), unavailableProfileSession());
  for (const value of [null, [], {...status(), account: {}}, {...status(), availability: ["available"]},
    {...status(), availability: "unavailable"}, {...status(), operation: undefined},
    {...status(), operation: {...operation(), email: "private@example.test"}},
    {...status(), operation: {...operation(), provider: ["codex"]}},
    {...status(), operation: {...operation(), phase: ["starting"]}},
    {...status(), operation: {...operation(), cleanup: "verified"}}])
    assert.throws(() => validateProfileSessionStatus(value), /contract_invalid/);
});

test("device challenges appear only during the fixed Codex login interaction", () => {
  const waiting = status({phase: "waiting_for_login", revision: 2, challenge});
  assert.deepEqual(validateProfileSessionStatus(waiting), waiting);
  assert.equal(validateProfileSessionStatus(status({phase: "waiting_for_login", challenge: null})).operation!.challenge, null);
  for (const changes of [{provider: "claude"}, {action: "status"}, {phase: "checking"}, {phase: "cleaning"},
    {challenge: {...challenge, verification_url: "https://auth.openai.com.evil.test/codex/device"}},
    {challenge: {...challenge, verification_url: "https://auth.openai.com/codex/device?code=private"}},
    {challenge: {...challenge, user_code: "private\noutput"}}, {challenge: {...challenge, user_code: "A".repeat(33)}},
    {challenge: {...challenge, token: "private"}}])
    assert.throws(() => validateProfileSessionStatus({...waiting, operation: {...waiting.operation!, ...changes}}), /contract_invalid/);
});

test("successful login and logout require their explicit postcondition and cleanup", () => {
  assert.equal(validateProfileSessionStatus(done()).operation!.session_state, "authenticated");
  assert.equal(validateProfileSessionStatus(done({action: "logout", session_state: "unauthenticated"})).operation!.session_state, "unauthenticated");
  for (const state of ["authenticated", "unauthenticated"] as const)
    assert.equal(validateProfileSessionStatus(done({action: "status", session_state: state})).operation!.session_state, state);
  for (const changes of [{session_state: "unknown"}, {session_state: "unauthenticated"}, {action: "logout"},
    {cleanup: "unknown"}, {error_code: "auth_required"}, {challenge}])
    assert.throws(() => validateProfileSessionStatus({...done(), operation: {...done().operation!, ...changes}}), /contract_invalid/);
});

test("failed or cancelled operations cannot retain authenticated state or device code", () => {
  for (const outcome of ["failed", "cancelled", "needs_review"] as const) {
    const terminal = done({outcome, session_state: "unknown", error_code: outcome === "cancelled" ? "cancelled" : "cleanup_failed", cleanup: outcome === "needs_review" ? "unknown" : "verified"});
    assert.deepEqual(validateProfileSessionStatus(terminal), terminal);
    for (const changes of [{session_state: "authenticated"}, {challenge}, {error_code: null}])
      assert.throws(() => validateProfileSessionStatus({...terminal, operation: {...terminal.operation!, ...changes}}), /contract_invalid/);
  }
  assert.throws(() => validateProfileSessionStatus(done({outcome: "cancelled", session_state: "unknown", error_code: "session_failed"})), /contract_invalid/);
});

test("admitted account operations cannot be replaced, regressed or rewritten at one revision", () => {
  const checking = status({phase: "checking", revision: 2});
  const waiting = status({phase: "waiting_for_login", revision: 3, challenge});
  assert.deepEqual(acceptProfileSessionUpdate(checking, waiting), waiting);
  for (const candidate of [status({phase: "preparing", revision: 3}), status({phase: "checking", revision: 1}),
    status({phase: "checking", revision: 2, action: "status"}), status({phase: "checking", revision: 3, profile_id: request}),
    status({phase: "checking", revision: 3, request_id: profile}), unavailableProfileSession()])
    assert.throws(() => acceptProfileSessionUpdate(checking, candidate), /status_stale/);
  assert.throws(() => acceptProfileSessionUpdate(waiting, status({phase: "waiting_for_login", revision: 3, challenge: {...challenge, user_code: "EFGH-67890"}})), /status_stale/);
  assert.deepEqual(acceptProfileSessionUpdate(waiting, status({phase: "waiting_for_login", revision: 4})), status({phase: "waiting_for_login", revision: 4}));
});

test("terminal observations are immutable and a later operation has a distinct identity", () => {
  const terminal = done();
  assert.deepEqual(acceptProfileSessionUpdate(terminal, terminal), terminal);
  assert.throws(() => acceptProfileSessionUpdate(terminal, done({revision: 5})), /status_stale/);
  const replacement = status({request_id: profile, profile_id: request, action: "status"});
  assert.deepEqual(acceptProfileSessionUpdate(terminal, replacement), replacement);
});

test("validated values are owned clones and challenge comparison is key-order independent", () => {
  const waiting = status({phase: "waiting_for_login", revision: 2, challenge: {...challenge}});
  const clone = validateProfileSessionStatus(waiting);
  clone.operation!.challenge!.user_code = "EFGH-67890";
  assert.equal(waiting.operation!.challenge!.user_code, challenge.user_code);
  const reordered = {...waiting, operation: {...waiting.operation!, challenge: {user_code: challenge.user_code, verification_url: challenge.verification_url}}};
  assert.deepEqual(acceptProfileSessionUpdate(waiting, reordered), reordered);
});
