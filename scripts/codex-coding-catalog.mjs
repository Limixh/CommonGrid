// Deterministic derivation of the pinned single-model Codex catalog used by the
// controlled coding task. Public data only: the source is the official Codex
// models.json at the pinned release, verified by SHA-256 before use.
import { createHash } from "node:crypto";

const sha256 = data => createHash("sha256").update(data).digest("hex");
/**
 * @param {Uint8Array} source raw models.json bytes
 * @param {{model: string, source_sha256: string}} pin
 * @returns {{value: string, sha256: string}}
 */
export function deriveCodexCodingCatalog(source, pin) {
  if (sha256(source) !== pin.source_sha256) throw new Error("codex_catalog_source_mismatch");
  const model = JSON.parse(Buffer.from(source).toString("utf8")).models.find(item => item.slug === pin.model);
  if (!model) throw new Error("codex_catalog_model_missing");
  // Direct tools only: no multi-agent or experimental tool surface.
  model.tool_mode = "direct"; model.multi_agent_version = "disabled"; model.experimental_supported_tools = [];
  const value = JSON.stringify({models: [model]}, null, 2) + "\n";
  return {value, sha256: sha256(value)};
}
