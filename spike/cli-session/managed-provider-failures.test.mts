// Deterministic official-protocol shapes only: no CLI, account or Docker calls.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProviderFailure, failureCode, type ProviderCategory } from "../../packages/agent-adapters/src/session-protocol.ts";
import { runCodexSessionProtocol, type CodexSessionOperation } from "./managed-provider-session.mts";

const privateMarker = "fixture-private-account@example.invalid Bearer fixture-private-token";
const failures: ReadonlyArray<{ category: ProviderCategory; message: string }> = [
  { category: "session_expired", message: "invalid_grant: refresh token expired" },
  { category: "quota", message: "429 Too many requests: usage limit reached" },
  { category: "auth_required", message: "401 Unauthorized: login required" },
  { category: "network", message: "ECONNRESET: network connection reset" },
  { category: "unclassified", message: "Unexpected provider condition" },
];

function transport(operation: CodexSessionOperation, message: string, notification: boolean) {
  const requests: Array<{ id?: number; method: string; params?: unknown }> = [];
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { kills++; return true; },
  });
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line); requests.push(request);
      if (request.id === undefined) continue;
      const target = operation === "quota" ? "account/rateLimits/read" : "account/read";
      const event = request.method === target
        ? notification
          ? { method: "error", params: { error: { message: `${message}; ${privateMarker}`, details: privateMarker } } }
          : { id: request.id, error: { code: -32000, message: `${message}; ${privateMarker}`, data: { account: privateMarker } } }
        : { id: request.id, result: request.method === "initialize" ? {} : { account: { type: "chatgpt", email: privateMarker } } };
      queueMicrotask(() => child.stdout.write(JSON.stringify(event) + "\n"));
    }
  });
  child.stderr.write(`${privateMarker}: raw provider stderr\n`);
  return { child: child as unknown as ChildProcessWithoutNullStreams, requests, get kills() { return kills; } };
}

for (const operation of ["status", "refresh", "quota"] as const) {
  for (const notification of [false, true]) {
    test(`Codex ${operation} ${notification ? "error notification" : "RPC failure"} stops for each provider category`, async context => {
      for (const { category, message } of failures) {
        await context.test(category, async () => {
          const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
          const controller = new AbortController();
          const f = transport(operation, message, notification);
          let caught: unknown;
          await assert.rejects(runCodexSessionProtocol(f.child, operation, { signal: controller.signal, deadlineMs: 1_000 }), error => {
            caught = error;
            return error instanceof ProviderFailure && error.category === category;
          });
          const expected = ["initialize", "initialized", "account/read", ...(operation === "quota" ? ["account/rateLimits/read"] : [])];
          assert.deepEqual(f.requests.map(request => request.method), expected, "no retry, login, logout, fallback or turn after failure");
          assert.deepEqual(f.requests[2].params, { refreshToken: operation === "refresh" });
          assert.ok(f.kills > 0, "failed transport must be stopped");
          assert.equal(failureCode(caught), `managed_provider_${category}`);
          const publicError = { failure: failureCode(caught), category: (caught as ProviderFailure).category };
          assert.equal(JSON.stringify(publicError).includes("fixture-private"), false);
          assert.equal((caught as Error).message.includes("fixture-private"), false);
          assert.equal((caught as Error).stack?.includes("fixture-private"), false);
          assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
        });
      }
    });
  }
}
