import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BindingFailure, ProfileBindings, validateBinding, type ProfileBinding } from "../../../apps/desktop/native-worker/profile-bindings.ts";
import { executeProfileSession, parseSessionBoot, profileBindingRoot, runProfileSession, type SessionBoot, type SessionDependencies, type SessionFrame, type SessionRuntime } from "../../../apps/desktop/native-worker/profile-session.ts";
import { ManagedPreparationError, type ManagedRuntimeAssets } from "../src/managed-runtime.ts";
import { ProviderFailure } from "../src/session-protocol.ts";
import { claudeLoginScopes } from "../src/claude-login-contract.ts";
import type { ProviderSessionOptions } from "../src/provider-session.ts";

const boot: SessionBoot = {type: "profile_session_boot", schema_version: "1.0", request_id: randomUUID(), profile_id: randomUUID(), provider: "codex", action: "login",
  journal_root: path.resolve("fixture-journal"), assets_root: path.resolve("fixture-assets"), profile_registry_root: path.resolve("fixture-appdata", "managed-profiles")};
const assets: ManagedRuntimeAssets = {baseImage: "node@sha256:" + "0".repeat(64), journalRoot: boot.journal_root, bridgeRoot: boot.assets_root,
  binaries: {claude: {binaryPath: path.resolve("fixture-claude"), sha256: "0".repeat(64)}, codex: {binaryPath: path.resolve("fixture-codex"), sha256: "1".repeat(64)}}};
function fixture(existing?: ProfileBinding) {
  const calls: string[] = [], frames: SessionFrame[] = [], state = {binding: existing}, stats = {control_failure: false};
  let retained = 0;
  const runtime: SessionRuntime = {
    async start() { calls.push("start"); }, async stop(destroy, options) { calls.push("stop"); assert.equal(destroy, false); assert.equal(options?.signal?.aborted, false); },
    async finishOperation(options) { calls.push("finish"); assert.equal(retained, 0, "operation borrower released before quiescent finish"); assert.equal(options?.signal?.aborted, false); },
    async retainOperation() { calls.push("retain"); retained++; return () => { calls.push("release"); retained--; }; },
    async publishPublicManifest(work) { calls.push("publish"); await work(); },
    async verifyOperation() { throw new Error("fixture_no_docker"); }, async beginNamespaceExec() { throw new Error("fixture_no_docker"); }, async exec() { throw new Error("fixture_no_docker"); },
  };
  const dependencies: SessionDependencies = {
    bindings(root) {
      assert.equal(root, profileBindingRoot(boot));
      return {
        async read() { calls.push("read"); return state.binding; },
        async reserve(profileId, provider) { calls.push("reserve"); assert.equal(state.binding, undefined); return state.binding = {schema_version: "1.0", profile_id: profileId, provider, owner: randomUUID(), state: "reserved"}; },
        async ready(binding) { calls.push("ready"); assert.equal(state.binding?.owner, binding.owner); return state.binding = {...binding, state: "ready"}; },
        async removeReserved(binding) { calls.push("remove-reserved"); assert.equal(state.binding?.owner, binding.owner); state.binding = undefined; },
      };
    },
    async assets() { calls.push("assets"); return assets; }, async prerequisite() { calls.push("prerequisite"); },
    async prepare(binding, options) { calls.push("prepare"); assert.equal(state.binding?.state, "reserved"); assert.equal(binding.owner, state.binding?.owner); assert.notEqual(binding.owner, boot.profile_id); assert.equal(options.assets, assets); return runtime; },
    restore(binding, actualAssets) { calls.push("restore"); assert.equal(binding.state, "ready"); assert.equal(actualAssets, assets); return runtime; },
    async bridge() { calls.push("bridge"); return {stats, close() { calls.push("bridge-close"); }}; },
    async session(_runtime, currentBoot, options) {
      calls.push("session"); assert.equal(retained, 1); assert.equal(options.deadlineMs, currentBoot.action === "login" ? 600_000 : 30_000);
      if (currentBoot.action === "login") await options.onDeviceChallenge?.({verification_url: "https://auth.openai.com/codex/device", user_code: "ABCD-EFGH"});
      return {authenticated: currentBoot.action !== "logout"};
    },
  };
  const run = (currentBoot = boot, signal = new AbortController().signal, interaction: Pick<ProviderSessionOptions,"onClaudeAuthorization"> = {}) => runProfileSession(currentBoot, signal, frame => frames.push(frame), dependencies, interaction);
  return {calls, frames, state, stats, runtime, dependencies, run};
}
const ready = (provider: "codex" | "claude" = "codex"): ProfileBinding => ({schema_version: "1.0", profile_id: boot.profile_id, provider, owner: randomUUID(), state: "ready"});
const result = (frames: SessionFrame[]) => frames.at(-1) as Extract<SessionFrame, {type: "result"}>;
test("session boot accepts only trusted fixed native paths and closed actions", () => {
  assert.deepEqual(parseSessionBoot(boot), boot);
  assert.equal(profileBindingRoot(boot), path.resolve("fixture-appdata", "managed-profile-sessions"));
  for (const value of [{...boot, argv: []}, {...boot, profile_id: "../x"}, {...boot, provider: "api"}, {...boot, action: "refresh"}, {...boot, assets_root: "relative"},
    {...boot, profile_registry_root: path.resolve("foreign-profile-store")}, {...boot, journal_root: path.resolve("x") + "\n"}, {...boot, type: "boot"}]) assert.throws(() => parseSessionBoot(value));
});
test("Codex login reserves owner before preparation, journals publication, relays only validated challenge and retains private volumes", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ["read", "assets", "prerequisite", "reserve", "prepare", "publish", "ready", "start", "retain", "bridge", "session", "bridge-close", "stop", "release", "finish"]);
  assert.equal(f.state.binding?.state, "ready");
  assert.deepEqual(f.frames.filter(frame => frame.type === "challenge"), [{type: "challenge", challenge: {verification_url: "https://auth.openai.com/codex/device", user_code: "ABCD-EFGH"}}]);
  assert.deepEqual(result(f.frames), {type: "result", outcome: "passed", session_state: "authenticated", error_code: null, cleanup: "verified"});
  assert.ok(!JSON.stringify(f.frames).includes(f.state.binding!.owner));
});
test("missing binding status/logout succeeds unauthenticated without assets, Docker or reservation", async () => {
  for (const action of ["status", "logout"] as const) {
    const f = fixture(); await f.run({...boot, action}); assert.deepEqual(f.calls, ["read"]);
    assert.deepEqual(f.frames.map(frame => frame.type), ["progress", "progress", "result"]);
    assert.equal(result(f.frames).session_state, "unauthenticated"); assert.equal(result(f.frames).outcome, "passed");
  }
});
test("Claude login without an interactive channel is unsupported before any binding or daemon access", async () => {
  const f = fixture(); await f.run({...boot, provider: "claude"}); assert.deepEqual(f.calls, []);
  assert.deepEqual(result(f.frames), {type: "result", outcome: "failed", session_state: "unknown", error_code: "unsupported", cleanup: "verified"});
});
const claudeState="S".repeat(43),claudeCode="fixture_code#"+claudeState;
const claudeUrl="https://claude.com/cai/oauth/authorize?"+new URLSearchParams({code:"true",client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",response_type:"code",redirect_uri:"https://platform.claude.com/oauth/code/callback",scope:claudeLoginScopes.join(" "),code_challenge:"P".repeat(43),code_challenge_method:"S256",state:claudeState});
test("Claude native login relays one validated URL and retains ready volumes through operation cleanup",async()=>{
  const f=fixture();let callbacks=0;
  f.dependencies.session=async(_runtime,currentBoot,options)=>{
    f.calls.push("session");assert.equal(currentBoot.provider,"claude");assert.equal(options.deadlineMs,600_000);
    assert.equal(await options.onClaudeAuthorization!({authorization_url:claudeUrl},options.signal!),claudeCode);
    return{authenticated:true};
  };
  await f.run({...boot,provider:"claude"},new AbortController().signal,{onClaudeAuthorization:async(challenge,signal)=>{
    callbacks++;assert.equal(signal.aborted,false);assert.equal(Object.isFrozen(challenge),true);return claudeCode;
  }});
  assert.equal(callbacks,1);assert.equal(f.state.binding?.provider,"claude");assert.equal(f.state.binding?.state,"ready");
  assert.deepEqual(f.frames.filter(frame=>frame.type==="challenge"),[{type:"challenge",challenge:{authorization_url:claudeUrl}}]);
  assert.deepEqual(f.calls.slice(-4),["bridge-close","stop","release","finish"]);
  assert.equal(result(f.frames).outcome,"passed");assert.ok(!JSON.stringify(f.frames).includes(claudeCode));
});
test("Claude worker rejects a foreign OAuth URL and cleans cancelled input with independent deadlines",async()=>{
  for(const fault of ["url","cancel"]){
    const f=fixture(),controller=new AbortController();let callbacks=0;
    f.dependencies.session=async(_runtime,_boot,options)=>{
      await options.onClaudeAuthorization!({authorization_url:fault==="url"?claudeUrl.replace("claude.com/","PRIVATE.invalid/"):claudeUrl},options.signal!);
      return{authenticated:true};
    };
    await f.run({...boot,provider:"claude"},controller.signal,{onClaudeAuthorization:async()=>{callbacks++;controller.abort("cancelled");throw new ProviderFailure("canceled");}});
    assert.equal(callbacks,fault==="url"?0:1);assert.equal(f.state.binding?.state,"ready");assert.deepEqual(f.calls.slice(-3),["stop","release","finish"]);
    assert.equal(result(f.frames).cleanup,"verified");assert.equal(result(f.frames).outcome,fault==="cancel"?"cancelled":"failed");assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("existing ready profiles restore exact owner for Codex/Claude status and logout", async () => {
  for (const provider of ["codex", "claude"] as const) for (const action of ["status", "logout"] as const) {
    const f = fixture(ready(provider)); await f.run({...boot, provider, action});
    assert.ok(f.calls.includes("restore")); assert.ok(!f.calls.includes("reserve") && !f.calls.includes("prepare"));
    assert.equal(result(f.frames).session_state, action === "logout" ? "unauthenticated" : "authenticated");
  }
});
test("interrupted reservations require review without preparing again", async () => {
  const f = fixture({...ready(), state: "reserved"}); await f.run(); assert.deepEqual(f.calls, ["read"]);
  assert.equal(result(f.frames).error_code, "profile_needs_review"); assert.equal(result(f.frames).cleanup, "unknown");
});
test("a reservation race cannot report verified cleanup for another operation's resources", async () => {
  const f = fixture(), original = f.dependencies.bindings;
  f.dependencies.bindings = root => ({...original(root), async reserve() { throw new BindingFailure("profile_needs_review"); }});
  await f.run(); assert.ok(!f.calls.includes("prepare"));
  assert.deepEqual(result(f.frames), {type: "result", outcome: "needs_review", session_state: "unknown", error_code: "profile_needs_review", cleanup: "unknown"});
});
test("assets and daemon prerequisites finish before durable reservation", async () => {
  for (const stage of ["assets", "prerequisite"] as const) {
    const f = fixture(); f.dependencies[stage] = async () => { throw {code: stage === "assets" ? "asset_invalid" : "image_missing", private: "PRIVATE"}; };
    await f.run(); assert.ok(!f.calls.includes("reserve")); assert.equal(result(f.frames).cleanup, "verified"); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("only verified preparation failure may remove the operation's own reservation", async () => {
  for (const verified of [true, false]) {
    const f = fixture(); f.dependencies.prepare = async () => { throw new ManagedPreparationError(verified, new Error("PRIVATE_AUTH_DETAIL")); };
    await f.run(); assert.equal(f.calls.includes("remove-reserved"), verified); assert.equal(f.state.binding === undefined, verified);
    assert.equal(result(f.frames).outcome, verified ? "failed" : "needs_review"); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("failed public publication preserves prepared reservation for review and only finishes operation", async () => {
  const f = fixture(); f.runtime.publishPublicManifest = async () => { throw new Error("PRIVATE_PUBLICATION_ERROR"); };
  await f.run(); assert.equal(f.state.binding?.state, "reserved"); assert.ok(f.calls.includes("finish")); assert.ok(!f.calls.includes("remove-reserved"));
  assert.equal(result(f.frames).error_code, "profile_needs_review"); assert.equal(result(f.frames).cleanup, "unknown");
});
test("cancelled or failed login preserves ready volumes and cleans with a fresh signal", async () => {
  for (const cancelled of [true, false]) {
    const controller = new AbortController(), f = fixture();
    f.dependencies.session = async () => { if (cancelled) controller.abort("cancelled"); throw new ProviderFailure("auth_required"); };
    await f.run(boot, controller.signal); assert.equal(f.state.binding?.state, "ready"); assert.equal(f.calls.at(-1), "finish");
    assert.equal(result(f.frames).error_code, cancelled ? "cancelled" : "auth_required"); assert.equal(result(f.frames).cleanup, "verified");
  }
});
test("relay health and challenge validation cannot be bypassed by a session fixture", async () => {
  for (const fault of ["before", "after", "challenge"] as const) {
    const f = fixture();
    if (fault === "before") f.stats.control_failure = true;
    else f.dependencies.session = async (_runtime, _boot, options) => {
      if (fault === "after") f.stats.control_failure = true;
      else await options.onDeviceChallenge?.({verification_url: "https://PRIVATE.invalid", user_code: "PRIVATE_CODE"});
      return {authenticated: true};
    };
    await f.run(); assert.notEqual(result(f.frames).outcome, "passed"); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("unconfirmed cleanup and cancel during cleanup never publish success", async () => {
  for (const fault of ["stop", "finish", "cancel"] as const) {
    const controller = new AbortController(), f = fixture();
    if (fault === "stop") f.runtime.stop = async () => { throw new Error("PRIVATE_CLEANUP"); };
    else f.runtime.finishOperation = async () => { if (fault === "cancel") controller.abort("deadline_exceeded"); else throw new Error("PRIVATE_CLEANUP"); };
    await f.run(boot, controller.signal); assert.notEqual(result(f.frames).outcome, "passed"); assert.equal(result(f.frames).session_state, "unknown");
    assert.equal(result(f.frames).error_code, fault === "cancel" ? "deadline_exceeded" : "cleanup_failed"); assert.ok(!JSON.stringify(f.frames).includes("PRIVATE"));
  }
});
test("binding store atomically reserves one owner, rejects replacement and bounds public data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-session-binding-")), root = path.join(directory, "registry"), stores = [new ProfileBindings(root), new ProfileBindings(root)];
  try {
    assert.equal(await stores[0].read(boot.profile_id, "codex"), undefined);
    const races = await Promise.allSettled(stores.map(store => store.reserve(boot.profile_id, "codex")));
    assert.equal(races.filter(value => value.status === "fulfilled").length, 1);
    const binding = (races.find(value => value.status === "fulfilled") as PromiseFulfilledResult<ProfileBinding>).value;
    assert.notEqual(binding.owner, binding.profile_id); assert.equal(binding.state, "reserved");
    const published = await stores[0].ready(binding); assert.equal(published.state, "ready");
    assert.deepEqual(await stores[1].read(boot.profile_id, "codex"), published);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(root, `${boot.profile_id}.json`), "utf8"))).sort(), ["owner", "profile_id", "provider", "schema_version", "state"]);
    await assert.rejects(stores[0].removeReserved(binding), BindingFailure);
    await assert.rejects(stores[0].read(boot.profile_id, "claude"), BindingFailure);
    await writeFile(path.join(root, `${boot.profile_id}.json`), "x".repeat(4097)); await assert.rejects(stores[0].read(boot.profile_id, "codex"), BindingFailure);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test("bindings reject malformed identity, state arrays, unknown fields and linked registry paths", async () => {
  const binding = ready();
  for (const value of [{...binding, owner: binding.profile_id}, {...binding, state: ["ready"]}, {...binding, auth: "PRIVATE"}, {...binding, state: "unknown"}]) assert.throws(() => validateBinding(value, boot.profile_id, "codex"), BindingFailure);
  const directory = await mkdtemp(path.join(tmpdir(), "cg-session-binding-link-"));
  try {
    const target = path.join(directory, "target"), linked = path.join(directory, "linked"); await mkdir(target); await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(new ProfileBindings(linked).read(boot.profile_id, "codex"), BindingFailure);
    await assert.rejects(new ProfileBindings(linked).reserve(boot.profile_id, "codex"), BindingFailure);
    await assert.rejects(new ProfileBindings(path.join(linked, "child")).reserve(boot.profile_id, "codex"), BindingFailure);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
test("Claude official status/logout use fixed argv and verify logged-out JSON without reading credential files", async () => {
  for (const action of ["status", "logout"] as const) {
    const f = fixture(), calls: string[][] = [];
    f.runtime.exec = async (argv, timeout, options) => {
      calls.push(argv); assert.equal(timeout, 30_000); assert.equal(options?.signal?.aborted, false);
      if (argv[2] === "logout") { assert.equal(options?.maxBytes, 4096); return {code: 0, stdout: "PRIVATE_DISCARDED_TEXT", stderr: ""}; }
      assert.equal(options?.maxBytes, 262_144); return {code: action === "logout" ? 1 : 0, stdout: JSON.stringify({loggedIn: action !== "logout", authMethod: action === "logout" ? "none" : "claude.ai"}), stderr: ""};
    };
    const result = await executeProfileSession(f.runtime, {...boot, provider: "claude", action}, {signal: new AbortController().signal, deadlineMs: 30_000});
    assert.deepEqual(calls, [...(action === "logout" ? [["/opt/cg/claude", "auth", "logout"]] : []), ["/opt/cg/claude", "auth", "status", "--json"]]);
    assert.equal(result.authenticated, action !== "logout");
  }
});
test("worker entry dispatches profile sessions and keeps stdout framed for no-daemon operations", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cg-session-entry-"));
  try {
    for (const provider of ["codex", "claude"] as const) {
      const input = {...boot, provider, action: "status", profile_registry_root: path.join(directory, "managed-profiles")};
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve("apps/desktop/native-worker/entry.ts")], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
      let stdout = "", stderr = "";
      child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
      child.stdin.on("error", () => {}); child.stdin.write(JSON.stringify(input) + "\n");
      const exit = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error("fixture_worker_deadline")); }, 15_000); child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve(code); }); });
      assert.equal(exit, 0); assert.equal(stderr, "");
      const frames = stdout.trim().split("\n").map(line => JSON.parse(line)) as SessionFrame[];
      assert.deepEqual(frames.map(frame => frame.type), ["progress", "progress", "result"]);
      assert.equal(result(frames).error_code, null);
      assert.equal(result(frames).session_state, "unauthenticated");
    }
  } finally { await rm(directory, {recursive: true, force: true}); }
});
