// Acceptance failure evidence is synthetic and never proves real expiry/renewal.
import assert from "node:assert/strict";
import test from "node:test";
import { ProviderFailure, classifyProviderFailure, type ProviderCategory } from "../../packages/agent-adapters/src/session-protocol.ts";
import { runSessionAcceptance, type AcceptanceEnvironment, type AcceptanceProvider } from "./managed-session-acceptance.mts";

const owner = "11111111-1111-4111-8111-111111111111";
const clock = Date.parse("2026-10-08T10:00:00.000Z");
const privateMarker = "fixture-private-account@example.invalid Bearer fixture-private-token";
const failures: ReadonlyArray<{ category: ProviderCategory; message: string }> = [
  { category: "session_expired", message: "invalid_grant: refresh token expired" },
  { category: "quota", message: "429 Too many requests: usage limit reached" },
  { category: "auth_required", message: "401 Unauthorized: login required" },
  { category: "network", message: "ECONNRESET: network connection reset" },
  { category: "unclassified", message: "Unexpected provider condition" },
];
const codexStages = ["initial_authenticated_status", "restart_authenticated_status", "official_codex_refresh_request", "post_refresh_authenticated_status", "read_only_codex_quota_snapshot"] as const;
type FailureStage = typeof codexStages[number];

function fixture(provider: AcceptanceProvider, stage: FailureStage, message: string) {
  const calls: string[] = [];
  let statuses = 0;
  const fail = () => {
    const raw = { code: -32000, message: `${message}; ${privateMarker}`, data: { account: privateMarker } };
    // Mirrors the provider boundary: classify official error text, retain only
    // the fixed category. Attached raw details must not enter the public report.
    const error = new ProviderFailure(classifyProviderFailure(raw));
    Object.assign(error, { raw_provider_payload: raw });
    throw error;
  };
  const environment: AcceptanceEnvironment = {
    start: async () => { calls.push("start"); },
    stop: async signal => { assert.equal(signal?.aborted, false); calls.push("stop"); },
    status: async () => {
      calls.push("status"); statuses++;
      const activeStage = ["initial_authenticated_status", "restart_authenticated_status", "post_refresh_authenticated_status"][statuses - 1];
      if (activeStage === stage) fail();
      return { authenticated: true, method: provider === "codex" ? "chatgpt" : "claude.ai", email: privateMarker };
    },
    refresh: async () => {
      calls.push("refresh"); if (stage === "official_codex_refresh_request") fail();
      return { authenticated: true, method: "chatgpt", refresh_requested: true, credential: privateMarker };
    },
    readQuota: async () => {
      calls.push("quota"); if (stage === "read_only_codex_quota_snapshot") fail();
      return { state: "unknown", source: "official_codex_account_rate_limits_read", reason: "unsupported_method", windows: [] };
    },
    assertHealthy: () => {}, now: () => clock,
  };
  return { calls, environment };
}

const prefix: Record<FailureStage, string[]> = {
  initial_authenticated_status: ["start", "status"],
  restart_authenticated_status: ["start", "status", "stop", "start", "status"],
  official_codex_refresh_request: ["start", "status", "stop", "start", "status", "refresh"],
  post_refresh_authenticated_status: ["start", "status", "stop", "start", "status", "refresh", "status"],
  read_only_codex_quota_snapshot: ["start", "status", "stop", "start", "status", "refresh", "status", "quota"],
};

for (const provider of ["codex", "claude"] as const) {
  const stages: readonly FailureStage[] = provider === "codex" ? codexStages : codexStages.slice(0, 2);
  for (const stage of stages) {
    test(`${provider} acceptance stops at ${stage} and preserves pending evidence`, async context => {
      for (const { category, message } of failures) {
        await context.test(category, async () => {
          const f = fixture(provider, stage, message);
          const { report, checkpoint } = await runSessionAcceptance({ provider, owner, realAccount: true, cleanupDeadlineMs: 25 }, f.environment);
          assert.deepEqual(f.calls, [...prefix[stage], "stop"], "no retry, later provider stage or fallback after failure");
          assert.equal(report.success, false); assert.equal(report.cleanup_confirmed, true);
          assert.equal(checkpoint, undefined);
          assert.equal(report.failure, `managed_provider_${category}`);
          assert.equal(report.provider_error_category, category);
          assert.equal(report.stages.at(-1).stage, stage);
          assert.equal(report.stages.at(-1).success, false);
          assert.equal(report.stages.at(-1).failure, `managed_provider_${category}`);
          assert.equal(report.stages.filter((entry: { success: boolean }) => !entry.success).length, 1);
          assert.equal(JSON.stringify({ report, checkpoint }).includes("fixture-private"), false);
          assert.equal(JSON.stringify(report).includes("raw_provider_payload"), false);
          assert.equal(report.real_provider_expiry_acceptance, "pending");
          assert.equal(report.claude_natural_expiry_evidence, provider === "claude" ? "pending" : "not_applicable");
          assert.equal(report.actual_token_rotation_observed, false);
          assert.equal(report.quota_exhaustion_verified, false);
          assert.equal(report.concurrent_account_usage_verified, false);
          assert.equal(report.quota_observation_is_usage_permission, false);
          assert.equal(report.real_model_inference_attempted, false);
          assert.equal(report.logout_attempted, false); assert.equal(report.paid_api_fallback, false);
          assert.equal(report.execution_enabled, false); assert.equal(report.isolation_gate, "not_evaluated");
          assert.equal(report.commercial_auth_accepted, false); assert.equal(report.production_use, false);
          assert.equal(report.official_codex_refresh_requested, provider === "codex" && ["official_codex_refresh_request", "post_refresh_authenticated_status", "read_only_codex_quota_snapshot"].includes(stage));
        });
      }
    });
  }
}
