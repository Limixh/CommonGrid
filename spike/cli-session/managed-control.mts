// Host half of the F0 stdio relay. Treat even the private CLI control stream as
// untrusted: validate envelopes before DNS, task dispatch, or reply allocation.
import { lookup } from "node:dns/promises";
import { connect, type Socket } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { providerHost, checkedAddresses, type SubscriptionProvider } from "../../packages/agent-adapters/src/egress-policy.ts";
import { Frames, sendFrame, sendData, decodeData } from "./tunnel-wire.mjs";

interface ControlOptions {
  provider: SubscriptionProvider;
  execute?: (arguments_: unknown) => Promise<unknown>;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  openSocket?: (address: string) => Socket;
  readyTimeoutMs?: number;
  dnsTimeoutMs?: number;
}
type Envelope = { kind: "ready" } | { kind: "connect"; id: string; authority: string } |
  { kind: "data"; id: string; data: string } | { kind: "close"; id: string } |
  { kind: "task"; id: string; arguments: unknown };
export function validateControlEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("managed_tunnel_protocol");
  const record = value as Record<string, unknown>;
  const fields: Record<string, string[]> = { ready: ["kind"], connect: ["kind", "id", "authority"], data: ["kind", "id", "data"], close: ["kind", "id"], task: ["kind", "id", "arguments"] };
  const expected = typeof record.kind === "string" && Object.hasOwn(fields, record.kind) ? fields[record.kind] : undefined;
  if (!expected || Object.keys(record).length !== expected.length || Object.keys(record).some(key => !expected.includes(key))) throw new Error("managed_tunnel_protocol");
  if (record.kind !== "ready" && (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id))) throw new Error("managed_tunnel_protocol");
  if (record.kind === "connect" && (typeof record.authority !== "string" || record.authority.length > 259)) throw new Error("managed_tunnel_protocol");
  if (record.kind === "data") decodeData(record.data);
  return record as Envelope;
}

export function attachManagedControl(child: ChildProcessWithoutNullStreams, options: ControlOptions) {
  const sockets = new Map<string, Socket>(), connecting = new Map<string, object>();
  const dnsTimers = new Map<object, NodeJS.Timeout>(), pausedSockets = new Map<Socket, () => void>(), outputDrains = new Map<Socket, () => void>();
  let bytes = 0, frameCount = 0, closed = false, announced = false, taskBusy = false;
  const stats = { connected: 0, denied: 0, task_calls: 0, destinations: [] as string[], denied_destinations: [] as string[], network_errors: [] as string[], control_failure: false };
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
  const frames = child.stdout.pipe(new Frames());
  const stop = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); connecting.clear();
    for (const timeout of dnsTimers.values()) clearTimeout(timeout); dnsTimers.clear();
    for (const [socket, drain] of pausedSockets) socket.removeListener("drain", drain); pausedSockets.clear();
    for (const drain of outputDrains.values()) child.stdin.removeListener("drain", drain); outputDrains.clear();
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear(); readyReject(new Error("managed_bridge_closed")); child.stdin.end(); child.kill();
  };
  const failed = () => { if (closed) return; stats.control_failure = true; readyReject(new Error("managed_bridge_failed")); stop(); };
  // stream.write(false) alone does not cap memory: bound the aggregate queue,
  // including task replies and connection rejection floods.
  const outputAvailable = () => { if (child.stdin.writableLength > 1_048_576) throw new Error("managed_tunnel_backpressure"); };
  const send = (value: unknown) => { if (!closed) { outputAvailable(); sendFrame(child.stdin, value); outputAvailable(); } };
  const remember = (list: string[], value: string, limit = 32) => { if (list.length < limit && !list.includes(value)) list.push(value); };
  const releaseBackpressure = (socket: Socket) => {
    const drain = pausedSockets.get(socket); if (!drain) return;
    socket.removeListener("drain", drain); pausedSockets.delete(socket);
    if (!closed && !pausedSockets.size) frames.resume();
  };
  const releaseOutputDrain = (socket: Socket) => {
    const drain = outputDrains.get(socket); if (!drain) return;
    child.stdin.removeListener("drain", drain); outputDrains.delete(socket);
  };
  child.on("error", failed); child.on("exit", failed); child.stdin.on("error", failed); child.stderr.on("data", () => {}); frames.on("error", failed);
  frames.on("data", (value: unknown) => {
    if (closed) return;
    void (async () => {
      const message = validateControlEnvelope(value);
      if (++frameCount > 65_536) throw new Error("managed_tunnel_frame_budget");
      if (message.kind === "ready") {
        if (announced) throw new Error("managed_tunnel_protocol");
        announced = true; readyResolve(); return;
      }
      if (!announced) throw new Error("managed_tunnel_protocol");
      if (message.kind === "connect") {
        // Canceled IDs do not release unresolved DNS admission. Otherwise a
        // connect/close flood bypasses the socket count while lookups accumulate.
        if (sockets.size + dnsTimers.size >= 16 || sockets.has(message.id) || connecting.has(message.id)) throw new Error("managed_tunnel_limit");
        const request = {}; connecting.set(message.id, request);
        dnsTimers.set(request, setTimeout(failed, options.dnsTimeoutMs ?? 10_000));
        try {
          const hostname = providerHost(options.provider, message.authority);
          const addresses = await (options.resolveAddresses ?? (async host => (await lookup(host, { family: 4, all: true })).map(item => item.address)))(hostname);
          // A canceled DNS request cannot claim a reused connection ID.
          if (closed || connecting.get(message.id) !== request) return;
          const address = checkedAddresses(addresses);
          const socket = (options.openSocket ?? (ip => connect({ host: ip, port: 443 })))(address); connecting.delete(message.id); sockets.set(message.id, socket);
          socket.setTimeout(120_000, () => socket.destroy());
          const connectionTimer = setTimeout(() => socket.destroy(), 10_000);
          socket.on("connect", () => { clearTimeout(connectionTimer); if (closed) { socket.destroy(); return; } stats.connected++; remember(stats.destinations, hostname); try { send({ kind: "connected", id: message.id }); } catch { failed(); } });
          socket.on("data", chunk => {
            if (closed) return;
            try {
              bytes += chunk.length; if (bytes > 134_217_728) throw new Error("managed_tunnel_budget");
              outputAvailable();
              if (!sendData(child.stdin, message.id, chunk) && !outputDrains.has(socket)) {
                socket.pause(); const drain = () => { releaseOutputDrain(socket); if (!closed && sockets.get(message.id) === socket) socket.resume(); };
                outputDrains.set(socket, drain); child.stdin.once("drain", drain);
              }
              outputAvailable();
            } catch { failed(); }
          });
          socket.on("error", (error: NodeJS.ErrnoException) => { releaseBackpressure(socket); releaseOutputDrain(socket); remember(stats.network_errors, ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"].includes(error.code ?? "") ? error.code! : "socket_failure", 16); });
          socket.on("close", () => { clearTimeout(connectionTimer); releaseBackpressure(socket); releaseOutputDrain(socket); if (sockets.get(message.id) === socket) sockets.delete(message.id); try { send({ kind: "close", id: message.id }); } catch { failed(); } });
        } catch (error) {
          if (closed || connecting.get(message.id) !== request) return;
          connecting.delete(message.id); stats.denied++;
          // Attacker-controlled domains and exception text can encode secrets.
          // Reports retain only this closed set of reason codes, never input.
          const reason = error instanceof Error && error.message === "egress_denied" ? "authority_denied" : error instanceof Error && error.message === "egress_address_denied" ? "private_dns_answer" : "dns_failure";
          remember(stats.denied_destinations, reason);
          if (reason !== "authority_denied") remember(stats.network_errors, reason, 16);
          send({ kind: "close", id: message.id });
        } finally { const timeout = dnsTimers.get(request); if (timeout) clearTimeout(timeout); dnsTimers.delete(request); }
      } else if (message.kind === "data") {
        const data = decodeData(message.data); bytes += data.length; if (bytes > 134_217_728) throw new Error("managed_tunnel_budget");
        const socket = sockets.get(message.id); if (!socket) return;
        if (!socket.write(data) && !pausedSockets.has(socket)) { frames.pause(); const drain = () => releaseBackpressure(socket); pausedSockets.set(socket, drain); socket.once("drain", drain); }
      } else if (message.kind === "close") { connecting.delete(message.id); sockets.get(message.id)?.destroy(); }
      else if (message.kind === "task") {
        let result: unknown = { error: "task_unavailable" };
        if (options.execute) {
          if (taskBusy) result = { error: "task_busy" };
          else if (stats.task_calls >= 16) result = { error: "task_call_limit" };
          else { stats.task_calls++; taskBusy = true; try { result = await options.execute(message.arguments); } finally { taskBusy = false; } }
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 48_000) result = { error: "task_output_limit" };
        send({ kind: "task-result", id: message.id, result });
      }
    })().catch(failed);
  });
  const timer = setTimeout(() => { readyReject(new Error("managed_bridge_deadline")); stop(); }, options.readyTimeoutMs ?? 15_000);
  ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
  return { stats, ready, close: stop, child };
}
