// Read-only capability inventory: version/help, pinned source hashes, no model
// invocation, account lookup, auth file read or task execution.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { probeTool as probe } from "../../scripts/tool-probes.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lock = JSON.parse(await readFile(new URL("sources.lock.json", import.meta.url), "utf8"));
const output = path.join(root, ".local/cli-routing");
const cache = path.join(output, "sources");
await mkdir(cache, { recursive: true });
const sourceChecks = [];
for (const source of lock.sources) {
  const cached = path.join(cache, `${source.id}.txt`);
  let bytes;
  try { bytes = await readFile(cached); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!bytes) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${source.id}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error(`Pinned source mismatch: ${source.id}`);
  await writeFile(cached, bytes);
  sourceChecks.push({ id: source.id, sha256: source.sha256, matched: true });
}

const codex = probe("codex", ["--version"]);
const codexHelp = codex.available ? probe("codex", ["exec", "--help"]) : { available: false, stdout: "" };
const claude = probe("claude", ["--version"]);
const claudeHelp = claude.available ? probe("claude", ["--help"]) : { available: false, stdout: "" };
const engines = ["docker", "podman"].map((id) => {
  const version = probe(id, ["--version"]);
  const reachable = version.available && probe(id, ["info", "--format", "{{.ServerVersion}}"]).available;
  return { id, installed: version.available, reachable };
});
const codexVersion = codex.stdout.trim().split(/\r?\n/)[0].slice(0, 100) || null;
const report = {
  schema_version: "1.0",
  checked_at: new Date().toISOString(),
  platform: process.platform,
  purpose: "read_only_inventory_and_pinned_source_review",
  source_checks: sourceChecks,
  codex: { version: codexVersion, matches_reviewed_version: codexVersion === `codex-cli ${lock.codex_version}`, exec_help_available: codexHelp.available, ephemeral_flag_documented_locally: codexHelp.stdout.includes("--ephemeral") },
  claude: {
    version: claude.stdout.trim().split(/\r?\n/)[0].slice(0, 100) || null,
    tools_allowlist_flag_documented_locally: claudeHelp.stdout.includes("--tools"),
    local_help_flags: Object.fromEntries(["--tools", "--strict-mcp-config", "--restricted", "--safe-mode", "--setting-sources", "--no-session-persistence", "--disable-slash-commands"].map((flag) => [flag, claudeHelp.stdout.includes(flag)])),
    resolution: claude.resolution,
    model_session_tested: false,
  },
  engines,
  swerex: { commit: lock.swerex_commit, installed_or_executed: false, runtime_gate: "not_evaluated" },
  reviewed_findings: [
    "Codex shell_tool gate is distinct from apply_patch registration; shell-off alone is not a complete file/tool routing design.",
    "Codex apply_patch_freeform is a removed compatibility flag in the pinned source, not a supported disable switch.",
    "SWE-ReX Docker deployment publishes a runtime API port and accepts docker_args; CommonGrid needs its own control-channel, network, resource and identity design.",
    "Claude local version/help capability inventory is recorded separately; no model session or built-in tool confinement was validated by this inventory."
  ],
  isolation_gate: "not_evaluated",
  execution_enabled: false,
  real_account_tested: false,
  required_evidence: ["OS identities and filesystem/process isolation", "all built-in file/command paths confined or disabled", "runtime API unreachable from task code", "timeout/cancellation and process cleanup", "token renewal/logout and provider compatibility", "Windows/macOS/Linux matrix"]
};
const reportPath = path.join(output, "report.json");
await writeFile(reportPath, JSON.stringify(report, null, 2)+"\n");
console.log(`Pinned sources: ${sourceChecks.length}/${lock.sources.length}; Codex: ${codexVersion ?? "missing"}`);
console.log(`Runtime engine reachable: ${engines.some((engine) => engine.reachable)}; isolation gate: not_evaluated`);
console.log(`Report: ${reportPath}`);
