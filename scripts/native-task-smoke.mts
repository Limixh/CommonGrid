import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { CommandError, runOwnedCommand, type CommandCleanup } from "../packages/agent-adapters/src/owned-process.ts";
import { validateManagedProfilesStatus } from "../packages/agent-adapters/src/managed-profile-protocol.ts";
import { acceptProfileSessionUpdate, validateClaudeAuthorizationUrl, validateProfileSessionStatus, type ProfileSessionStatus } from "../packages/agent-adapters/src/profile-session-protocol.ts";
import { acceptTaskRunUpdate, taskRunObservedModels, taskRunRequestedModels, validateTaskRunStatus, type TaskRunOperation, type TaskRunProvider, type TaskRunStatus } from "../packages/agent-adapters/src/task-run-protocol.ts";
import { applyControlledPatch, controlledBaseline, controlledVerifierCases } from "../packages/agent-adapters/src/controlled-task.ts";
import { readOperationJournals } from "../packages/agent-adapters/src/operation-journal.ts";
import { operationLeaseLabels } from "../packages/agent-adapters/src/operation-lease.ts";
import { ProfileBindings } from "../apps/desktop/native-worker/profile-bindings.ts";
import { root } from "./go.mjs";
import { createNativeUiTrace, safeNativeUiErrorCategory } from "./native-ui-trace.mts";

// Real packaged Windows/WebView2 acceptance. Native IPC is never replaced.
// Default: a fresh signed-out profile, no account import and no inference.
// --real-account is explicit consent to one cheap-model task after the user
// authorizes the official flow. Only Codex's device challenge goes to stdout;
// Fresh Claude login requires a visible app and manual entry in its masked code
// field. --reuse-session uses only a previously authorized isolated run store.
// No DOM dumps, raw errors, videos or challenge screenshots. Claude real-account
// mode collects only bounded allowlisted UI/IPC events and safe session metadata.
const arguments_ = process.argv.slice(2);
const usage = "Usage: npm run test:native-task-smoke -- [--provider codex|claude] [--real-account] [--show] [--reuse-session <v4 UUID>]\nDefault: Codex signed-out task failure and cancellation without model inference.\n--real-account: wait for official user authorization; run one gpt-6-luna (Codex) or haiku (Claude) task.\nCodex prints its official device URL/code once. Fresh Claude login requires --real-account --show: use the app's official browser button and paste the code only into its masked field. Claude URL/code/state are never printed.\n--reuse-session: use only an already authenticated .local/native-task-smoke/<UUID>/appdata store; requires --real-account. Official CLI status must verify authentication before one cheap task. No login, fallback or automatic retry; --show is optional for reuse. New reports/config/artifacts go into a separate run directory.\n--show: show the isolated native window (requires --real-account).\nThe isolated app store and official profile volumes are retained; host auth is never copied.";
if (arguments_.includes("--help")) { console.log(usage); process.exit(0); }
let provider: TaskRunProvider = "codex", realAccount = false, show = false;
let sourceSessionRunId: string | null = null;
const seenArguments = new Set<string>();
for (let index = 0; index < arguments_.length; index++) {
  const argument = arguments_[index];
  assert.ok(["--provider", "--real-account", "--show", "--reuse-session"].includes(argument), "native_task_smoke_unknown_argument");
  assert.ok(!seenArguments.has(argument), "native_task_smoke_duplicate_argument"); seenArguments.add(argument);
  if (argument === "--provider") {
    const value = arguments_[++index];
    assert.ok(value === "codex" || value === "claude", "native_task_smoke_invalid_provider"); provider = value;
  } else if (argument === "--reuse-session") {
    const value = arguments_[++index];
    assert.ok(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), "native_task_smoke_invalid_source_session_run_id");
    sourceSessionRunId = value.toLowerCase();
  } else if (argument === "--real-account") realAccount = true;
  else show = true;
}
assert.ok(!show || realAccount, "native_task_smoke_visible_login_requires_real_account_flag");
assert.ok(!sourceSessionRunId || realAccount, "native_task_smoke_reuse_requires_real_account_flag");
assert.ok(provider !== "claude" || !realAccount || show || sourceSessionRunId, "native_task_smoke_claude_real_account_requires_visible_app");
if (process.platform !== "win32") throw new Error("native_task_smoke_requires_windows_webview2");
assert.equal(taskRunRequestedModels.codex, "gpt-6-luna", "native_task_smoke_cheap_model_policy_changed");
assert.equal(taskRunRequestedModels.claude, "haiku", "native_task_smoke_cheap_model_policy_changed");
const requestedModel = taskRunRequestedModels[provider];
const profileName = provider === "claude" ? "Claude native task smoke" : "Codex native task smoke";

const smokeRoot = path.resolve(root, ".local/native-task-smoke");
const directory = path.join(smokeRoot, randomUUID());
const appdata = path.join(sourceSessionRunId ? path.join(smokeRoot, sourceSessionRunId) : directory, "appdata");
function withinRun(filename: string) {
  const resolved = path.resolve(filename), relative = path.relative(directory, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "native_task_smoke_path_outside_run");
  return resolved;
}
function withinAppdata(filename: string) {
  const resolved = path.resolve(filename), relative = path.relative(appdata, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "native_task_smoke_path_outside_isolated_appdata");
  return resolved;
}
if (sourceSessionRunId) {
  // Directory metadata only: never inspect private account files. Reject a
  // redirected store as well as arbitrary paths masquerading as a run UUID.
  try {
    const sourceRun = path.join(smokeRoot, sourceSessionRunId);
    const sourceInfo = await lstat(sourceRun), appdataInfo = await lstat(appdata);
    assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink() && appdataInfo.isDirectory() && !appdataInfo.isSymbolicLink());
    const expected = path.join(await realpath(smokeRoot), sourceSessionRunId, "appdata");
    assert.equal((await realpath(appdata)).toLowerCase(), expected.toLowerCase());
  } catch { throw new Error("native_task_smoke_source_store_missing_invalid_or_redirected"); }
}
await mkdir(smokeRoot, {recursive: true});
await mkdir(directory);
const config = withinRun(path.join(directory, "tauri-smoke.json"));
await writeFile(config, JSON.stringify({app: {
  appDirectoriesOverride: sourceSessionRunId ? appdata : withinRun(appdata),
  windows: [{label: "main", title: sourceSessionRunId ? "CommonGrid isolated session task smoke" : provider === "claude" && realAccount ? "CommonGrid — Claude hesabını bağla" : "CommonGrid native task smoke", visible: show, width: 1380, height: 1200}],
}}, null, 2) + "\n");

const checks: string[] = [];
const taskEvidence: Array<{
  purpose: "unbound" | "signed_out_cancel" | "authenticated_task";
  outcome: TaskRunOperation["outcome"]; error_code: TaskRunOperation["error_code"];
  cleanup: TaskRunOperation["cleanup"]; tool_calls: number; model: TaskRunOperation["model"];
}> = [];
let stage = "build", success = false, realNativeIpc = false, challengeSeen = false, challengePrinted = false;
let diagnosticStage: string | null = null;
const nativeUiTrace = createNativeUiTrace(() => diagnosticStage ?? stage);
const observeClaudeUi = provider === "claude" && realAccount;
let accountAuthorized = false, inferenceAttempted = false;
let authentication: "not_requested" | "pending" | "passed" | "failed" = "not_requested";
let authenticatedTask: "not_requested" | "pending" | "passed" | "failed" = "not_requested";
let processCleanup: CommandCleanup = {method: "none", status: "not_started"};
let buildCleanup: CommandCleanup = {method: "none", status: "not_started"};
let failureCode: string | null = null;
let uiFailureCategory: string | null = null;
let browser: Browser | undefined, activePage: Page | undefined;
let taskSnapshot: TaskRunStatus | null = null, sessionSnapshot: ProfileSessionStatus | null = null;
let sourceTaskRequestId: string | undefined, sourceSessionRequestId: string | undefined;
let reuseOperationsStarted = false;
let verified: {cases: number; candidate_sha256: string; patch_sha256: string; applied_candidate_sha256: string} | null = null;
const independentManagedCleanup: {
  status: "not_checked" | "failed" | "verified"; journal_operations: number;
  namespace_ids_checked: number; lease_ids_checked: number;
  managed_containers_absent: boolean; profile_claims_absent: boolean;
} = {status: "not_checked", journal_operations: 0, namespace_ids_checked: 0, lease_ids_checked: 0,
  managed_containers_absent: false, profile_claims_absent: false};
const controller = new AbortController();
let completion: Promise<{result?: unknown; error?: unknown}> | undefined;
let interrupted = false;
const onInterrupt = () => { interrupted = true; };
process.on("SIGINT", onInterrupt); process.on("SIGTERM", onInterrupt);

class SmokeFailure extends Error { constructor(readonly code: string) { super(code); } }
async function bounded<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmokeFailure(code)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function assertNotInterrupted() { if (interrupted) throw new SmokeFailure("interrupted"); }
type Command = "local_managed_profiles_status" | "local_profile_session_status" | "local_profile_session_cancel" | "local_task_run_status" | "local_task_run_cancel";
async function invoke(page: Page, command: Command, args: unknown = {}) {
  return await bounded(page.evaluate(({command, args}) => (globalThis as any).__TAURI_INTERNALS__.invoke(command, args), {command, args}),
    10_000, "native_ipc_deadline");
}
async function session(page: Page) {
  const current = validateProfileSessionStatus(await invoke(page, "local_profile_session_status"));
  nativeUiTrace.observeSession(current);
  assert.equal(current.availability, "available"); realNativeIpc = true;
  sessionSnapshot = acceptProfileSessionUpdate(sessionSnapshot, current);
  return sessionSnapshot;
}
async function task(page: Page) {
  const current = validateTaskRunStatus(await invoke(page, "local_task_run_status"));
  assert.equal(current.availability, "available"); realNativeIpc = true;
  taskSnapshot = acceptTaskRunUpdate(taskSnapshot, current);
  return taskSnapshot;
}
async function waitSession(page: Page, predicate: (status: ProfileSessionStatus) => boolean, timeoutMs: number, previousRequest?: string, cleanupOnly = false) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    if (!cleanupOnly) assertNotInterrupted();
    const current = await session(page);
    if (!previousRequest || current.operation?.request_id !== previousRequest) {
      if (predicate(current)) return current;
      if (current.operation?.phase === "finished") throw new SmokeFailure(`session_${current.operation.error_code ?? current.operation.outcome}`);
    }
    await delay(200);
  }
  throw new SmokeFailure("session_observation_deadline");
}
async function waitTask(page: Page, predicate: (status: TaskRunStatus) => boolean, timeoutMs: number, previousRequest?: string, cleanupOnly = false) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    if (!cleanupOnly) assertNotInterrupted();
    const current = await task(page);
    if (!previousRequest || current.operation?.request_id !== previousRequest) {
      if (predicate(current)) return current;
      if (current.operation?.phase === "finished") throw new SmokeFailure(`task_${current.operation.error_code ?? current.operation.outcome}`);
    }
    await delay(100);
  }
  throw new SmokeFailure("task_observation_deadline");
}
function evidence(purpose: typeof taskEvidence[number]["purpose"], operation: TaskRunOperation) {
  assert.equal(operation.phase, "finished");
  assert.equal(operation.provider, provider); assert.equal(operation.model.requested, requestedModel);
  taskEvidence.push({purpose, outcome: operation.outcome, error_code: operation.error_code,
    cleanup: operation.cleanup, tool_calls: operation.tool_calls, model: {...operation.model}});
}
async function startTaskUi(page: Page) {
  assertNotInterrupted();
  const panel = page.locator(".task-run-panel");
  await expect(panel).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("button", {name: "Başlat", exact: true})).toBeDisabled();
  await panel.getByRole("checkbox", {name: "Bu görevi seçili profilin hesabıyla çalıştırmayı onaylıyorum.", exact: true}).check();
  await panel.getByRole("button", {name: "Başlat", exact: true}).click();
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
}
async function sessionStatusUi(page: Page, expected: "authenticated" | "unauthenticated") {
  const previous = (await session(page)).operation?.request_id;
  await page.locator(".profile-session-panel").getByRole("button", {name: "CLI hesabını kontrol et", exact: true}).click();
  const operation = (await waitSession(page, status => status.operation?.phase === "finished", 160_000, previous)).operation!;
  assert.equal(operation.action, "status"); assert.equal(operation.outcome, "passed");
  assert.equal(operation.provider, provider);
  assert.equal(operation.session_state, expected); assert.equal(operation.cleanup, "verified"); assert.equal(operation.challenge, null);
  return operation;
}
async function verifyBinding(profileId: string) {
  const bindingRoot = withinAppdata(path.join(appdata, "managed-profile-sessions"));
  assert.deepEqual(await readdir(bindingRoot), [`${profileId}.json`]);
  const binding = await new ProfileBindings(bindingRoot).read(profileId, provider);
  assert.ok(binding);
  assert.equal(binding.state, "ready"); assert.notEqual(binding.owner, profileId);
  return binding;
}
// Read-only independent evidence for this isolated managed profile only. Task,
// exporter and verifier resources have separate random owners and remain
// covered by native supervisor cleanup evidence, not this inventory.
async function verifyIndependentManagedCleanup(profileId: string) {
  independentManagedCleanup.status = "failed";
  const binding = await verifyBinding(profileId);
  const catalog = await readOperationJournals(withinAppdata(path.join(appdata, "managed-operation-journal")));
  assert.equal(catalog.status, "available", "native_task_smoke_journal_unavailable");
  assert.ok(catalog.operations.length > 0, "native_task_smoke_journal_missing");
  for (const operation of catalog.operations) {
    assert.equal(operation.identity.owner, binding.owner, "native_task_smoke_journal_owner_mismatch");
    assert.equal(operation.identity.provider, binding.provider, "native_task_smoke_journal_provider_mismatch");
    assert.equal(operation.terminal, true, "native_task_smoke_journal_not_terminal");
    assert.deepEqual(operation.pending, [], "native_task_smoke_journal_pending_intents");
  }
  independentManagedCleanup.journal_operations = catalog.operations.length;
  const absent = async (filter: string) => {
    const listed = await runOwnedCommand("docker", ["container", "ls", "--all", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"],
      {timeoutMs: 15_000, maxBytes: 65_536});
    assert.equal(listed.code, 0, "native_task_smoke_docker_inventory_failed");
    assert.equal(listed.stdout.trim(), "", "native_task_smoke_owned_container_remains");
  };
  await absent(`label=io.commongrid.spike.owner=${binding.owner}`);
  independentManagedCleanup.managed_containers_absent = true;
  await absent(`label=${operationLeaseLabels.owner}=${binding.owner}`);
  independentManagedCleanup.profile_claims_absent = true;
  for (const id of new Set(catalog.operations.flatMap(operation => [...operation.namespace_ids]))) {
    await absent(`id=${id}`); independentManagedCleanup.namespace_ids_checked++;
  }
  for (const id of new Set(catalog.operations.flatMap(operation => operation.lease_id ? [operation.lease_id] : []))) {
    await absent(`id=${id}`); independentManagedCleanup.lease_ids_checked++;
  }
  independentManagedCleanup.status = "verified";
}
// Best effort only. Never cancel a replacement request; resynchronize once if
// progress changed the revision while a failure cleanup request was in flight.
async function cancelOwnedOperation(page: Page, kind: "task" | "session") {
  if (sourceSessionRunId && !reuseOperationsStarted) return;
  const read = kind === "task" ? task : session;
  const before = (await read(page)).operation;
  if (!before || before.phase === "finished") return;
  if (sourceSessionRunId && before.request_id === (kind === "task" ? sourceTaskRequestId : sourceSessionRequestId)) return;
  const command = kind === "task" ? "local_task_run_cancel" : "local_profile_session_cancel";
  try { await invoke(page, command, {request: {schema_version: "1.0", request_id: before.request_id, expected_revision: before.revision}}); }
  catch {
    const current = (await read(page)).operation;
    if (!current || current.request_id !== before.request_id || current.phase === "finished" || current.revision === before.revision) return;
    await invoke(page, command, {request: {schema_version: "1.0", request_id: current.request_id, expected_revision: current.revision}});
  }
  if (kind === "task") await waitTask(page, status => status.operation?.request_id === before.request_id && status.operation.phase === "finished", 45_000, undefined, true);
  else await waitSession(page, status => status.operation?.request_id === before.request_id && status.operation.phase === "finished", 45_000, undefined, true);
}

try {
  console.log(`Building isolated native Windows task acceptance (${sourceSessionRunId ? "explicit existing-isolated-session mode" : realAccount ? "explicit real-account mode" : "signed-out mode; no inference"})…`);
  assertNotInterrupted();
  try {
    // Build output remains bounded in memory and is discarded, never reported.
    const build = await runOwnedCommand(process.execPath, [path.join(root, "scripts/native.mjs"), "build", "--debug", "--no-bundle", "--config", config],
      {timeoutMs: 600_000, maxBytes: 4_194_304});
    assert.equal(build.code, 0);
  } catch (error) {
    if (error instanceof CommandError) buildCleanup = await error.cleanup;
    throw new SmokeFailure("native_build_failed");
  }
  assertNotInterrupted(); stage = "launch";
  const port = await bounded(new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address(); assert.ok(address && typeof address === "object");
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  }), 5000, "cdp_port_deadline");
  const previous = process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  let processFinished = false;
  try {
    completion = runOwnedCommand(path.join(root, "apps/desktop/src-tauri/target/debug/commongrid-desktop.exe"), [],
      {signal: controller.signal, timeoutMs: realAccount ? 2_400_000 : 900_000, maxBytes: 1_048_576})
      .then(result => { processFinished = true; return {result}; }, error => { processFinished = true; return {error}; });
  } finally {
    if (previous === undefined) delete process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    else process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = previous;
  }
  const expires = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < expires && !processFinished) {
    assertNotInterrupted();
    try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(500)})).ok; if (ready) break; } catch {}
    await delay(200);
  }
  assert.ok(ready, "native_task_smoke_cdp_bootstrap_failed");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {timeout: 10_000});
  const context = browser.contexts()[0]; assert.ok(context);
  const page = context.pages()[0] ?? await context.waitForEvent("page", {timeout: 10_000}); activePage = page;
  page.setDefaultTimeout(15_000);
  await page.waitForURL(url => url.hostname === "tauri.localhost" || url.protocol === "tauri:", {timeout: 15_000});
  await page.reload({waitUntil: "domcontentloaded", timeout: 15_000});
  assert.equal(await page.evaluate(() => (globalThis as any).isTauri), true);
  if (observeClaudeUi) { stage = "install_passive_ui_observer"; await nativeUiTrace.install(page); stage = "open_agents"; }
  await page.locator(".local-controlled-task").getByRole("button", {name: "Kontrollü görevi seç", exact: true}).click();
  await expect(page.locator(".execution-selection-panel")).toHaveAttribute("data-selection-kind", "controlled");
  checks.push("workspace_explicit_local_task_selection_reaches_native_profile_screen");
  const profiles = page.locator(".managed-profiles-panel"), sessionPanel = page.locator(".profile-session-panel");
  await expect(profiles).toHaveAttribute("aria-busy", "false");
  const taskPanel = page.locator(".task-run-panel");
  let profileId: string, previousTaskRequest: string | undefined;
  if (sourceSessionRunId) {
    stage = "reuse_selected_profile";
    const catalog = validateManagedProfilesStatus(await invoke(page, "local_managed_profiles_status"));
    assert.equal(catalog.availability, "available");
    assert.equal(catalog.profiles.length, 1, "native_task_smoke_reuse_requires_exactly_one_profile");
    const selected = catalog.profiles[0];
    assert.equal(selected.provider, provider, "native_task_smoke_reuse_provider_mismatch");
    assert.equal(catalog.selected_profile_id, selected.profile_id, "native_task_smoke_reuse_requires_selected_profile");
    profileId = selected.profile_id;
    await expect(sessionPanel).toHaveAttribute("aria-busy", "false");
    const existingTask = (await task(page)).operation;
    sourceTaskRequestId = existingTask?.request_id; previousTaskRequest = sourceTaskRequestId;
    if (existingTask && existingTask.phase !== "finished") throw new SmokeFailure("reuse_existing_task_active");
    const existingSession = (await session(page)).operation;
    sourceSessionRequestId = existingSession?.request_id;
    if (existingSession && existingSession.phase !== "finished") throw new SmokeFailure("reuse_existing_session_active");
    checks.push("real_native_ui_loads_exact_single_matching_selected_isolated_profile_without_fresh_login");
    stage = "reuse_official_authenticated_status"; authentication = "pending";
    await verifyBinding(profileId);
    reuseOperationsStarted = true;
    const authenticated = await sessionStatusUi(page, "authenticated");
    assert.equal(authenticated.profile_id, profileId);
    accountAuthorized = true; authentication = "passed";
    checks.push("official_cli_status_verifies_existing_isolated_session_authenticated_before_one_cheap_task");
  } else {
    await expect(profiles).toHaveAttribute("aria-busy", "false"); stage = "fresh_profile";
    const empty = validateManagedProfilesStatus(await invoke(page, "local_managed_profiles_status"));
    assert.equal(empty.availability, "available"); assert.deepEqual(empty.profiles, []); assert.equal(empty.selected_profile_id, null);
    await profiles.getByLabel("Profil adı", {exact: true}).fill(profileName);
    await profiles.getByLabel("Ajan", {exact: true}).selectOption(provider);
    await profiles.getByRole("button", {name: "Profil oluştur", exact: true}).click();
    await expect(profiles).toHaveAttribute("aria-busy", "false");
    await profiles.locator(".managed-profile-list li").filter({hasText: profileName}).getByRole("button", {name: "Bu profili seç", exact: true}).click();
    await expect(sessionPanel).toHaveAttribute("aria-busy", "false");
    const catalog = validateManagedProfilesStatus(await invoke(page, "local_managed_profiles_status"));
    profileId = catalog.selected_profile_id!;
    assert.ok(profileId); assert.equal(catalog.profiles.length, 1); assert.equal(catalog.profiles[0].provider, provider);
    assert.equal((await task(page)).operation, null); assert.equal((await session(page)).operation, null);
    checks.push(`real_native_ui_creates_and_selects_fresh_isolated_${provider}_profile`);

    stage = "unbound_task"; console.log("Checking task approval and unbound-profile failure through the native UI…");
    await startTaskUi(page);
    const unbound = (await waitTask(page, status => status.operation?.phase === "finished", 30_000)).operation!;
    previousTaskRequest = unbound.request_id;
    evidence("unbound", unbound);
    assert.equal(unbound.profile_id, profileId); assert.equal(unbound.outcome, "failed"); assert.equal(unbound.error_code, "profile_unbound");
    assert.equal(unbound.cleanup, "verified"); assert.equal(unbound.tool_calls, 0); assert.equal(unbound.model.observed, null); assert.equal(unbound.result, null);

    await expect(taskPanel.getByText("Bu profil için bağlı bir hesap ortamı yok. Yukarıdaki panelden hesabını bağla.", {exact: true})).toBeVisible();
    assert.equal(await taskPanel.locator(".task-run-diff").count(), 0);
    checks.push("native_ui_requires_per_run_approval_and_reports_unbound_profile_with_verified_cleanup");

    stage = "device_login"; authentication = realAccount ? "pending" : "not_requested";
    console.log(`Preparing the isolated profile through the official ${provider === "claude" ? "Claude authorization" : "Codex device"} flow…`);
    await sessionPanel.getByRole("button", {name: provider === "claude" ? "Claude hesabını bağla" : "Codex hesabını bağla", exact: true}).click();
    // Keep the observation snapshot immutable: clearing this transient local
    // copy must not make a same-revision challenge poll look like a rewind.
    const waiting = structuredClone((await waitSession(page, status => status.operation?.phase === "waiting_for_login" && !!status.operation.challenge, 300_000)).operation!);
    assert.equal(waiting.profile_id, profileId); assert.equal(waiting.provider, provider); assert.ok(waiting.challenge);
    if (provider === "claude") {
      assert.ok("authorization_url" in waiting.challenge);
      validateClaudeAuthorizationUrl(waiting.challenge.authorization_url);
      const codeField = sessionPanel.getByLabel("Claude geçici giriş kodu", {exact: true});
      await expect(codeField).toBeVisible(); await expect(codeField).toHaveAttribute("type", "password");
      await expect(sessionPanel.getByRole("button", {name: "Claude giriş sayfasını aç", exact: true})).toBeVisible();
      checks.push("official_claude_authorization_challenge_reaches_real_native_profile_masked_code_ui");
    } else {
      assert.ok("user_code" in waiting.challenge);
      assert.equal(waiting.challenge.verification_url, "https://auth.openai.com/codex/device");
      assert.ok(/^[A-Z0-9-]{4,32}$/.test(waiting.challenge.user_code));
      await expect(sessionPanel.getByTestId("profile-session-code")).toBeVisible();
      checks.push("official_codex_device_challenge_reaches_real_native_profile_ui");
    }
    challengeSeen = true;
    if (realAccount) {
      if (provider === "claude") {
        // The user opens the browser using the actual native app button and
        // submits the code only in its masked field. Never read that field,
        // automate browser auth, print the URL/state, or copy private auth.
        await sessionPanel.getByLabel("Claude geçici giriş kodu", {exact: true}).scrollIntoViewIfNeeded();
        console.log("Waiting for user: in the visible CommonGrid window, click 'Claude giriş sayfasını aç', complete official login, paste the returned code only into 'Claude geçici giriş kodu', and click 'Giriş kodunu gönder'.");
      } else {
        assert.ok("user_code" in waiting.challenge);
        console.log(`Official authorization: https://auth.openai.com/codex/device\nDevice code: ${waiting.challenge.user_code}`);
        challengePrinted = true;
      }
      waiting.challenge = null;
      stage = "await_official_authorization";
      const authorized = (await waitSession(page, status => status.operation?.phase === "finished", 650_000)).operation!;
      assert.equal(authorized.request_id, waiting.request_id); assert.equal(authorized.action, "login"); assert.equal(authorized.provider, provider);
      if (authorized.outcome !== "passed" || authorized.session_state !== "authenticated" || authorized.cleanup !== "verified")
        throw new SmokeFailure(`session_${authorized.error_code ?? "authentication_not_completed"}`);
      accountAuthorized = true; authentication = "passed";
      await expect(sessionPanel.getByTestId("profile-session-code")).toHaveCount(0);
      await expect(sessionPanel.getByLabel("Claude geçici giriş kodu", {exact: true})).toHaveCount(0);
      await verifyBinding(profileId);
      await sessionStatusUi(page, "authenticated");
      checks.push("official_user_authorization_and_followup_status_verify_fresh_isolated_authenticated_profile");
    } else {
      waiting.challenge = null; stage = "cancel_login";
      console.log("Cancelling the undisclosed authorization challenge without authorizing an account…");
      await sessionPanel.getByRole("button", {name: "Bağlantı işlemini iptal et", exact: true}).click();
      const cancelled = (await waitSession(page, status => status.operation?.phase === "finished", 45_000)).operation!;
      assert.equal(cancelled.request_id, waiting.request_id); assert.equal(cancelled.outcome, "cancelled");
      assert.equal(cancelled.cleanup, "verified"); assert.equal(cancelled.challenge, null);
      await expect(sessionPanel.getByTestId("profile-session-code")).toHaveCount(0);
      await expect(sessionPanel.getByLabel("Claude geçici giriş kodu", {exact: true})).toHaveCount(0);
      await verifyBinding(profileId);
      await sessionStatusUi(page, "unauthenticated");
      checks.push("undisclosed_login_cancel_verifies_cleanup_and_official_signed_out_profile_status");
      stage = "signed_out_task_cancel";
      console.log("Starting and cancelling a signed-out task before any model can be authorized…");
      await startTaskUi(page);
      const started = (await waitTask(page, status => !!status.operation, 10_000, unbound.request_id)).operation!;
      assert.ok(started.phase === "starting" || started.phase === "preparing", "native_task_smoke_cancel_window_missed");
      assert.equal(started.model.observed, null); assert.equal(started.tool_calls, 0);
      await taskPanel.getByRole("button", {name: "İptal", exact: true}).click();
      const cancelledTask = (await waitTask(page, status => status.operation?.phase === "finished", 60_000)).operation!;
      evidence("signed_out_cancel", cancelledTask);
      assert.equal(cancelledTask.request_id, started.request_id); assert.equal(cancelledTask.outcome, "cancelled"); assert.equal(cancelledTask.error_code, "cancelled");
      assert.equal(cancelledTask.cleanup, "verified"); assert.equal(cancelledTask.tool_calls, 0); assert.equal(cancelledTask.model.observed, null); assert.equal(cancelledTask.result, null);
      await expect(taskPanel.getByText("Görev iptal edildi", {exact: true})).toBeVisible();
      checks.push("signed_out_native_ui_task_cancel_has_verified_cleanup_zero_tools_and_no_observed_model");
      stage = "signed_out_status_after_cancel";
      await sessionStatusUi(page, "unauthenticated");
      await verifyBinding(profileId);
      checks.push("official_signed_out_profile_status_after_task_cancel_with_retained_public_binding");
    }
  }
  if (realAccount) {
    stage = "authenticated_task"; authenticatedTask = "pending";
    console.log(`Running one approved controlled task with ${requestedModel}; no model fallback…`);
    inferenceAttempted = true;
    await startTaskUi(page);
    const result = (await waitTask(page, status => status.operation?.phase === "finished", 1_300_000, previousTaskRequest)).operation!;
    evidence("authenticated_task", result);
    if (result.outcome !== "passed") throw new SmokeFailure(`task_${result.error_code ?? result.outcome}`);
    assert.equal(result.profile_id, profileId); assert.equal(result.model.requested, requestedModel);
    assert.ok(result.model.observed && taskRunObservedModels[provider].includes(result.model.observed));
    assert.equal(result.cleanup, "verified"); assert.ok(result.tool_calls > 0 && result.tool_calls <= 16);
    assert.ok(result.result?.patch && result.result.patch_sha256);
    assert.deepEqual(result.result.verifier, {passed: true, cases: controlledVerifierCases, json_cases_passed: true, sparse_cases_passed: true});
    assert.equal(controlledVerifierCases, 34);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const appliedHash = digest(applyControlledPatch(controlledBaseline, result.result.patch));
    assert.equal(digest(result.result.patch), result.result.patch_sha256); assert.equal(appliedHash, result.result.candidate_sha256);
    verified = {cases: 34, candidate_sha256: result.result.candidate_sha256, patch_sha256: result.result.patch_sha256, applied_candidate_sha256: appliedHash};
    await expect(taskPanel.getByText("34/34 örnek geçti", {exact: false})).toBeVisible();
    await expect(taskPanel.locator(".task-run-hashes code").filter({hasText: result.result.candidate_sha256.slice(0, 12)})).toHaveAttribute("title", result.result.candidate_sha256);
    await expect(taskPanel.locator(".task-run-hashes code").filter({hasText: result.result.patch_sha256.slice(0, 12)})).toHaveAttribute("title", result.result.patch_sha256);
    await writeFile(withinRun(path.join(directory, "verified.patch")), result.result.patch);
    authenticatedTask = "passed";
    checks.push(provider === "claude" ? "real_haiku_native_ui_task_passes_34_independent_cases_and_patch_roundtrip_hashes" : "real_gpt_6_luna_native_ui_task_passes_34_independent_cases_and_patch_roundtrip_hashes");
    stage = "account_status_after_task";
    await sessionStatusUi(page, "authenticated");
    await verifyBinding(profileId);
    checks.push("task_cleanup_retains_isolated_official_session_and_followup_authenticated_status");
  }
  stage = "independent_managed_cleanup";
  await verifyIndependentManagedCleanup(profileId);
  checks.push("isolated_managed_profile_terminal_journals_and_independent_exact_owned_container_claim_absence");
  stage = "final_ui";
  await expect(sessionPanel.getByTestId("profile-session-code")).toHaveCount(0);
  await expect(sessionPanel.getByLabel("Claude geçici giriş kodu", {exact: true})).toHaveCount(0);
  await taskPanel.screenshot({path: withinRun(path.join(directory, "native-task-after-cleanup.png"))});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push("native_task_result_panel_screenshot_after_challenge_removal_and_no_horizontal_overflow");
  success = true; stage = "complete";
} catch (error) {
  // Playwright failures can quote the DOM (including a transient challenge).
  // Report only a locally constructed code or a fixed stage-specific failure.
  failureCode = error instanceof SmokeFailure ? error.code : `${stage}_assertion_failed`;
  if (observeClaudeUi) uiFailureCategory = safeNativeUiErrorCategory(error);
  if (authentication === "pending") authentication = "failed";
  if (authenticatedTask === "pending") authenticatedTask = "failed";
} finally {
  diagnosticStage = success ? "process_cleanup" : "failure_cleanup";
  if (!success && activePage && !activePage.isClosed()) {
    try { await cancelOwnedOperation(activePage, "task"); } catch { /* No independent cleanup claim. */ }
    try { await cancelOwnedOperation(activePage, "session"); } catch { /* No independent cleanup claim. */ }
  }
  controller.abort("smoke_finished");
  if (completion) {
    const finished = await completion;
    if (finished.error instanceof CommandError) processCleanup = await finished.error.cleanup;
    else processCleanup = {method: "none", status: "unconfirmed"};
  }
  if (browser) await bounded(browser.close(), 5000, "browser_disconnect_deadline").catch(() => {});
  process.off("SIGINT", onInterrupt); process.off("SIGTERM", onInterrupt);
  const passed = success && processCleanup.status === "termination_reported";
  const report = {
    schema_version: "1.0", checked_at: new Date().toISOString(), purpose: "real_native_windows_controlled_task_acceptance", provider, mode: sourceSessionRunId ? "reuse_authenticated_session" : realAccount ? "real_account" : "signed_out",
    source_session_run_id: sourceSessionRunId, authentication_method: sourceSessionRunId ? "existing_isolated_session" : realAccount ? "official_user_authorization" : "not_requested",
    success: passed, status: passed ? "passed" : "failed", stage, failure_code: failureCode ?? (passed ? null : "process_cleanup_unconfirmed"), checks,
    real_native_ipc: realNativeIpc, mocked_native_ipc: false, device_challenge_seen: provider === "codex" && challengeSeen,
    claude_oauth_challenge_seen: provider === "claude" && challengeSeen, authorization_url_recorded: false, claude_login_code_recorded: false,
    device_code_printed_once_for_explicit_real_account: challengePrinted, device_code_recorded_in_files: false,
    official_authentication: authentication, real_account_authorized: accountAuthorized,
    authenticated_task: authenticatedTask, requested_model: requestedModel, real_model_inference_attempted: inferenceAttempted,
    user_account_imported: false, paid_api_fallback: false, default_user_app_store_accessed: false,
    task_evidence: taskEvidence, verified_result: verified, independent_managed_cleanup: independentManagedCleanup,
    independent_managed_cleanup_journal_scope: sourceSessionRunId ? "cumulative_source_isolated_store_public_journals" : "current_isolated_store_public_journals",
    last_session_metadata: nativeUiTrace.report().last_session_metadata,
    ...(observeClaudeUi ? {native_ui_diagnostics: {...nativeUiTrace.report(), failure_category: uiFailureCategory}} : {}),
    build_cleanup: buildCleanup, process_cleanup: processCleanup,
    isolated_store_retained: true, official_profile_volumes_retained: true,
    browser_open_requested_by_harness: false, user_browser_action_required: provider === "claude" && realAccount && !sourceSessionRunId,
    scope_limits: [
      "Only --real-account requests inference; signed-out mode never reveals its authorization challenge and checks a fresh official signed-out profile.",
      sourceSessionRunId
        ? "Existing isolated session reuse verifies exactly one matching selected profile and official authenticated status before one approved cheap task; no login, account import, browser interaction, fallback or automatic retry. Reports, config and artifacts use a separate new run directory."
        : provider === "claude"
        ? "Claude authenticated acceptance requires --real-account --show and manual user authorization via the native app browser button and masked code field; the harness neither opens nor inspects the official browser or private auth."
        : "Authenticated acceptance requires user completion of the official Codex device authorization; auth is never copied from the host.",
      `Exactly one authenticated controlled task is requested with fixed ${requestedModel}; an unavailable model or exhausted quota stops without fallback or retry.`,
      "Verified task cleanup is native supervisor evidence; owned application termination does not independently prove absence of every WebView descendant.",
      "Independent read-only journal and Docker absence checks cover the isolated managed profile containers and claims; separate random-owner task, exporter and verifier resources remain native supervisor evidence.",
      ...(sourceSessionRunId ? ["Independent cleanup reads cumulative public journals from the source isolated store, including earlier operations; it does not claim those operations occurred in this report run."] : []),
      "The isolated app store and official session volumes are retained for review; this harness performs no broad Docker deletion.",
    ],
  };
  await writeFile(withinRun(path.join(directory, "report.json")), JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${path.join(directory, "report.json")}`);
  if (!passed) { console.error(`FAIL native Windows task acceptance: ${report.failure_code}`); process.exitCode = 1; }
  else console.log(`PASS native Windows task acceptance (${report.mode}): ${checks.length} checks`);
}
