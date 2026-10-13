// One official-CLI provider turn for the controlled coding task, inside an already
// started managed runtime. Only validated scalars leave this module: an observed
// model identity and a tool-call count. Prompts, tool arguments/results and
// provider payloads stay transient. The cheap functional-test model is enforced
// here: a missing or different model is a failure, never a fallback.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ClaudeFunctionalTestModelGuard } from "../testing/functional-test-models.ts";
import { BoundedJsonInput, BoundedJsonLines, ProviderFailure, RpcLifecycle, TaskCallbackGuard, assertBridgeHealthy, classifyProviderFailure, isRecord, validRpcId,
  rejectClaudeSyntheticAssistantError, validateClaudeResult, validateClaudeStatus, validateCodexIdentity, validateCodexTurn } from "./session-protocol.ts";
import { controlledTaskExecDescription, controlledTaskPrompt, controlledTaskToolSchema } from "./controlled-task.ts";
import { taskRunMaxToolCalls, taskRunObservedModels, taskRunRequestedModels, type TaskRunProvider } from "./task-run-protocol.ts";

export class TaskToolLimitError extends Error { constructor() { super("managed_task_call_limit"); } }
export interface ProviderTurnRuntime {
  verifyOperation(options?: {signal?: AbortSignal}): Promise<string>;
  beginNamespaceExec(containerId: string, options?: {signal?: AbortSignal}): Promise<unknown>;
  exec(args: string[], timeoutMs?: number, options?: {signal?: AbortSignal; maxBytes?: number}): Promise<{code: number; stdout: string}>;
}
export type ProviderProcessFactory = (containerId: string, args: string[]) => ChildProcessWithoutNullStreams;
export interface ProviderTurnObserver { model(observed: string): void; toolCall(count: number): void }
export interface ProviderTurnTrace { quiescent: boolean }
export interface ProviderTurnOptions {
  provider: TaskRunProvider;
  runtime: ProviderTurnRuntime;
  /** Runs one validated task_exec call against the isolated task sandbox. */
  execute(arguments_: unknown): Promise<unknown>;
  /** Relay health and executed-call counter of the managed bridge. */
  bridgeStats: {control_failure?: unknown; task_calls?: unknown};
  signal: AbortSignal;
  observer: ProviderTurnObserver;
  /** Set once the callback queue has settled; ownership must not be released before. */
  trace: ProviderTurnTrace;
  deadlineMs?: number;
  spawnProcess?: ProviderProcessFactory;
}

// Only these reconstructed scalar fields enter tool replies. Command arguments,
// stdout/stderr contents and provider payloads remain transient.
export function prepareTaskToolReply(value: unknown) {
  const reply = isRecord(value) ? value : {};
  const exitCode = Number.isSafeInteger(reply.exit_code) ? reply.exit_code as number : null;
  const stdoutBytes = typeof reply.stdout === "string" ? Buffer.byteLength(reply.stdout) : null;
  const stderrBytes = typeof reply.stderr === "string" ? Buffer.byteLength(reply.stderr) : null;
  let body: Record<string, unknown>;
  if (Object.hasOwn(reply, "error")) body = {error: reply.error === "task_output_limit" ? "task_output_limit" : "task_tool_failed"};
  else if (exitCode === null || stdoutBytes === null || stderrBytes === null) body = {error: "task_tool_failed"};
  else body = {exit_code: exitCode, stdout: reply.stdout, stderr: reply.stderr};
  let text = JSON.stringify(body), success = Object.hasOwn(body, "exit_code") && body.exit_code === 0;
  if (Buffer.byteLength(text) > 48_000) { success = false; text = '{"error":"task_output_limit"}'; }
  return {success, contentItems: [{type: "inputText", text}]};
}
export async function settleCallbacks(queue: Promise<void>, deadlineMs = 30_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([queue.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const claudeArgs = ["/opt/cg/claude", "--print", "--verbose", "--output-format", "stream-json", "--tools", "", "--restricted", "--strict-mcp-config", "--mcp-config", "/home/node/mcp.json", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--permission-mode", "dontAsk", "--allowedTools", "mcp__commongrid__task_exec"];
export function providerCommand(provider: TaskRunProvider): string[] {
  const model = taskRunRequestedModels[provider];
  if (provider === "claude") return [...claudeArgs, "--model", model, "--fallback-model", model, controlledTaskPrompt];
  return ["/opt/cg/codex", "app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"', "-c", `model="${model}"`, "-c", 'model_catalog_json="/opt/cg/catalog.json"', "-c", "agents.enabled=false", "-c", 'model_reasoning_effort="low"',
    "-c", 'model_provider="openai"', "-c", 'web_search="disabled"', "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-c", "features.apps=false", "-c", "features.code_mode_only=false", "-c", "features.code_mode=false",
    "-c", "features.goals=false", "-c", "features.current_time_reminder=false", "-c", "features.sleep_tool=false", "-c", "features.tool_search=false", "-c", "features.token_budget=false", "-c", "tools.experimental_request_user_input.enabled=false"];
}
const defaultSpawn: ProviderProcessFactory = (containerId, args) => spawn("docker", ["exec", "-i", containerId, ...args], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});

export async function runControlledProviderTurn(options: ProviderTurnOptions): Promise<void> {
  const {provider, runtime, observer, signal} = options, requestedModel = taskRunRequestedModels[provider];
  let child: ChildProcessWithoutNullStreams | undefined, input: BoundedJsonInput | undefined, lines: ReturnType<typeof createInterface> | undefined;
  let queue = Promise.resolve(), toolCalls = 0, limitExceeded = false, modelEmitted = false;
  const rpc = new RpcLifecycle(line => child!.stdin.write(line), options.deadlineMs ?? 300_000, () => { try { child?.stdin.end(); child?.kill(); } catch {} });
  const abort = () => rpc.fail(new ProviderFailure(signal.reason === "deadline_exceeded" ? "deadline" : "canceled"));
  const noteModel = (observed: string) => {
    if (!(taskRunObservedModels[provider] as readonly string[]).includes(observed)) throw new ProviderFailure("model");
    if (!modelEmitted) { modelEmitted = true; observer.model(observed); }
  };
  const noteToolCall = (count: number) => {
    if (count > taskRunMaxToolCalls) { limitExceeded = true; throw new ProviderFailure("protocol"); }
    if (count > toolCalls) { toolCalls = count; observer.toolCall(count); }
  };
  signal.addEventListener("abort", abort, {once: true});
  try {
    if (signal.aborted) abort();
    rpc.assertActive();
    const claudeModelGuard = new ClaudeFunctionalTestModelGuard(), toolUses = new Set<string>();
    if (provider === "claude") {
      const status = await runtime.exec(["/opt/cg/claude", "auth", "status", "--json"], 15_000, {signal, maxBytes: 262_144});
      validateClaudeStatus(status.stdout, status.code, true);
    }
    rpc.assertActive();
    const containerId = await runtime.verifyOperation({signal});
    await runtime.beginNamespaceExec(containerId, {signal});
    rpc.assertActive();
    child = (options.spawnProcess ?? defaultSpawn)(containerId, providerCommand(provider));
    child.stderr.on("data", () => {}); child.stdin.on("error", () => rpc.fail(new ProviderFailure("process"))); child.stdout.on("error", () => rpc.fail(new ProviderFailure("process")));
    child.on("error", () => rpc.fail(new ProviderFailure("process"))); child.on("close", () => { void queue.finally(() => rpc.processExit()); });
    const decoder = new BoundedJsonLines(4_194_304, 1_048_576), callbacks = new TaskCallbackGuard();
    let threadId: string | undefined, turnId: string | undefined, earlyTurn: unknown, turnRequested = false;
    const completeCodexTurn = (params: unknown) => { validateCodexTurn(params, threadId!, turnId!); rpc.finish(); };
    input = new BoundedJsonInput(4_194_304, 1_048_576); input.on("error", () => rpc.fail(new ProviderFailure("protocol")));
    lines = createInterface({input, crlfDelay: Infinity}); child.stdout.pipe(input);
    lines.on("error", () => rpc.fail(new ProviderFailure("protocol")));
    lines.on("line", line => {
      // Account for incoming bytes before waiting for a running tool callback.
      // This also bounds all queued messages by the total stream limit.
      let event: Record<string, any>;
      try { event = decoder.decode(line); } catch { rpc.fail(new ProviderFailure("protocol")); return; }
      queue = queue.then(async () => {
        rpc.assertHealthy();
        if (provider === "claude") {
          rejectClaudeSyntheticAssistantError(event);
          claudeModelGuard.observe(event);
          if (claudeModelGuard.observedModel) noteModel(claudeModelGuard.observedModel);
          if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
            for (const block of event.message.content) if (isRecord(block) && block.type === "tool_use") {
              toolUses.add(typeof block.id === "string" && block.id.length <= 128 ? block.id : `anonymous-${toolUses.size}`); noteToolCall(toolUses.size);
            }
          }
          if (event.type === "result") { validateClaudeResult(event); if (!claudeModelGuard.observedModel) throw new ProviderFailure("model"); rpc.finish(); }
          else if (typeof event.type !== "string") throw new ProviderFailure("protocol");
        } else if (rpc.response(event)) return;
        else if (event.method === "item/tool/call") {
          rpc.assertActive();
          if (!turnRequested) throw new ProviderFailure("protocol");
          // The seventeenth request is a tool limit, not a malformed callback.
          if (toolCalls >= taskRunMaxToolCalls) noteToolCall(toolCalls + 1);
          const arguments_ = callbacks.validate(event, threadId);
          noteToolCall(toolCalls + 1);
          const reply = prepareTaskToolReply(await options.execute(arguments_));
          rpc.assertActive();
          child!.stdin.write(JSON.stringify({id: event.id, result: reply}) + "\n");
        } else if (Object.hasOwn(event, "id")) {
          if (validRpcId(event.id)) child!.stdin.write(JSON.stringify({id: event.id, error: {code: -32601, message: "Unsupported callback in controlled task"}}) + "\n");
          throw new ProviderFailure("protocol");
        } else if (typeof event.method !== "string" || !event.method || !isRecord(event.params)) throw new ProviderFailure("protocol");
        else if (event.method === "turn/completed") {
          if (!turnRequested || !threadId || earlyTurn !== undefined) throw new ProviderFailure("protocol");
          if (turnId) completeCodexTurn(event.params); else earlyTurn = event.params;
        } else if (event.method === "error") throw new ProviderFailure(classifyProviderFailure(event.params.error ?? event.params));
      }).catch(error => rpc.fail(error instanceof ProviderFailure ? error : new ProviderFailure("protocol")));
    });
    if (provider === "claude") child.stdin.end();
    else {
      await rpc.request("initialize", {clientInfo: {name: "commongrid_controlled_task", version: "0.1.0"}, capabilities: {experimentalApi: true}});
      child.stdin.write(JSON.stringify({method: "initialized"}) + "\n");
      validateCodexIdentity(await rpc.request("account/read", {refreshToken: true}), "refresh");
      const models = await rpc.request("model/list", {});
      if (!isRecord(models) || !Array.isArray(models.data) || !models.data.every((item: unknown) => isRecord(item) && typeof item.model === "string" && item.model.length <= 128 && typeof item.hidden === "boolean")) throw new ProviderFailure("protocol");
      // The cheap model must be offered as is; there is no fallback to another one.
      if (!models.data.some((item: any) => item.model === requestedModel && !item.hidden)) throw new ProviderFailure("model");
      const schema = controlledTaskToolSchema;
      const started = await rpc.request("thread/start", {model: requestedModel, modelProvider: "openai", cwd: "/home/node", approvalPolicy: "never", sandbox: "read-only", ephemeral: true, environments: [], baseInstructions: controlledTaskPrompt,
        dynamicTools: [{type: "function", name: "task_exec", description: controlledTaskExecDescription, inputSchema: schema}]});
      if (!isRecord(started) || !isRecord(started.thread)) throw new ProviderFailure("protocol");
      if (started.model !== requestedModel) throw new ProviderFailure("model");
      noteModel(started.model);
      threadId = started.thread.id;
      if (typeof threadId !== "string" || !threadId || threadId.length > 128) throw new ProviderFailure("protocol");
      turnRequested = true;
      const turn = await rpc.request("turn/start", {threadId, input: [{type: "text", text: controlledTaskPrompt, text_elements: []}]});
      if (!isRecord(turn) || !isRecord(turn.turn) || typeof turn.turn.id !== "string" || !turn.turn.id || turn.turn.id.length > 128) throw new ProviderFailure("protocol");
      turnId = turn.turn.id;
      if (earlyTurn !== undefined) completeCodexTurn(earlyTurn);
    }
    await rpc.done; lines.close(); await queue; rpc.assertHealthy();
    assertBridgeHealthy(options.bridgeStats);
    if (!modelEmitted) throw new ProviderFailure("model");
    if (provider === "claude") {
      // The relay counter is authoritative for executed calls; stream blocks cover rejected extras.
      const executed = Number(options.bridgeStats.task_calls);
      if (!Number.isSafeInteger(executed) || executed < 0) throw new ProviderFailure("protocol");
      noteToolCall(Math.max(toolUses.size, executed));
    }
    if (toolCalls < 1) throw new ProviderFailure("protocol");
  } catch (error) {
    if (limitExceeded) throw new TaskToolLimitError();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    rpc.dispose(); lines?.close();
    if (input) { child?.stdout.unpipe(input); input.destroy(); }
    try { child?.stdin.end(); } catch {} try { child?.kill(); } catch {}
    // A queued tool callback must settle before ownership can be released.
    options.trace.quiescent = await settleCallbacks(queue);
  }
}
