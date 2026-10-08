// User-selected models for CommonGrid functionality tests only.
// Development agents keep their independently selected Sol 6.1/high profile.
import { ProviderFailure, isRecord } from "../src/session-protocol.ts";
export const codexFunctionalTestModel = "gpt-6-luna";
export const claudeFunctionalTestModel = "haiku";

// Direct Anthropic identities verified against the official Haiku migration
// guide. The requested alias is never accepted as an observed model identity.
export const claudeFunctionalTestObservedModels = Object.freeze([
  "claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-haiku-5-5",
] as const);
export type ClaudeFunctionalTestObservedModel = typeof claudeFunctionalTestObservedModels[number];
function observedModel(value: unknown): ClaudeFunctionalTestObservedModel {
  if (typeof value !== "string" || !value.length) throw new ProviderFailure("protocol");
  if (!(claudeFunctionalTestObservedModels as readonly string[]).includes(value)) throw new ProviderFailure("model");
  return value as ClaudeFunctionalTestObservedModel;
}
function usageModel(value: unknown, expected?: ClaudeFunctionalTestObservedModel) {
  if (!isRecord(value)) throw new ProviderFailure("protocol");
  const models = Object.keys(value);
  if (!models.length || models.length > 3) throw new ProviderFailure("protocol");
  const verified = models.map(observedModel);
  if (verified.length !== 1 || expected !== undefined && verified[0] !== expected) throw new ProviderFailure("model");
  if (!isRecord(value[verified[0]])) throw new ProviderFailure("protocol");
  return verified[0];
}
// JSON output omits the init event, so require actual aggregate modelUsage.
export function validateClaudeFunctionalTestJsonModel(event: unknown): ClaudeFunctionalTestObservedModel {
  if (!isRecord(event) || event.type !== "result" || event.subtype !== "success" || event.is_error !== false) throw new ProviderFailure("protocol");
  return usageModel(event.modelUsage);
}
export class ClaudeFunctionalTestModelGuard {
  private model?: ClaudeFunctionalTestObservedModel;
  private failure?: ProviderFailure;
  private completed = false;
  get observedModel() { return this.model; }
  observe(event: unknown) {
    if (this.failure) throw this.failure;
    try {
      if (!isRecord(event) || typeof event.type !== "string" || this.completed) throw new ProviderFailure("protocol");
      if (event.type === "system" && event.subtype === "init") {
        if (this.model) throw new ProviderFailure("protocol");
        this.model = observedModel(event.model);
      } else if (event.type === "assistant") {
        if (!this.model || !isRecord(event.message)) throw new ProviderFailure("protocol");
        if (observedModel(event.message.model) !== this.model) throw new ProviderFailure("model");
      } else if (event.type === "result" && event.subtype === "success" && event.is_error === false) {
        if (!this.model) throw new ProviderFailure("protocol");
        if (Object.hasOwn(event, "modelUsage")) usageModel(event.modelUsage, this.model);
        this.completed = true;
      }
    } catch (error) {
      this.failure = error instanceof ProviderFailure ? error : new ProviderFailure("protocol");
      throw this.failure;
    }
  }
}
