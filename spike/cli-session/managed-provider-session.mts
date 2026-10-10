// Developer terminal compatibility; product session operations remain silent.
import type { ManagedCliRuntime } from "../../packages/agent-adapters/src/managed-runtime.ts";
import { codexRpc as productCodexRpc, type CodexSessionOperation, type ProviderSessionOptions } from "../../packages/agent-adapters/src/provider-session.ts";
export * from "../../packages/agent-adapters/src/provider-session.ts";

export function codexRpc(runtime: Pick<ManagedCliRuntime,"verifyOperation"|"beginNamespaceExec">, operation: CodexSessionOperation, options: ProviderSessionOptions = {}) {
  return productCodexRpc(runtime, operation, {
    ...options,
    ...(operation === "login" && options.onDeviceChallenge === undefined ? {
      onDeviceChallenge: ({ verification_url, user_code }: {verification_url: string; user_code: string}) => {
        console.log(`Open ${verification_url} and enter ${user_code}. Approve only your own login. Waiting up to 10 minutes.`);
      },
    } : {}),
  });
}
