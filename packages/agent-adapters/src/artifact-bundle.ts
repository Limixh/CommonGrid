import { createHash } from "node:crypto";
import { validateTask, type TaskContract } from "@commongrid/task-schema";

export const artifactLimits = { archiveBytes: 64 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, files: 256, manifestBytes: 64 * 1024 } as const;
export type ArtifactBinding = {
  purpose: "result" | "checkpoint"; task_id: string; task_version: number;
  contract_hash: string; lease_id: string; base_commit: string; strategy_id: string;
};
export type ArtifactFile = { path: string; bytes: Uint8Array };
// The caller supplies a trusted local scanner. This is independent of the
// server's required scan, and never grants a server verification verdict.
export type ArtifactScanner = (files: readonly ArtifactFile[]) => Promise<void>;
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const hash = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function reject(code: string): never { throw new Error(code); }

export function safeArtifactPath(value: string): boolean {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_.\/-]+$/.test(value) || value.startsWith("/")) return false;
  return value.split("/").every((part) => {
    const lower = part.toLowerCase();
    return part !== "" && part !== "." && part !== ".." && !part.endsWith(".") &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part) &&
      ![".git", ".codex", ".claude", ".ssh", ".aws", ".npmrc", ".netrc", "auth.json", "credentials", "credentials.json", "id_rsa", "id_ed25519"].includes(lower) &&
      lower !== ".env" && !lower.startsWith(".env.");
  });
}

export function inspectArtifactText(bytes: Uint8Array): string {
  if (bytes.byteLength > artifactLimits.fileBytes) reject("artifact_file_limit");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return reject("artifact_invalid_utf8"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) reject("artifact_unsafe_content");
  const secrets = [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/'"@:]+:[^\s/'"@]+@/i,
    /["'`]?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)["'`]?\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/i,
  ];
  if (secrets.some((pattern) => pattern.test(text))) reject("artifact_secret_content");
  return text;
}

function validateBinding(task: TaskContract, binding: ArtifactBinding) {
  if (!binding || !["result", "checkpoint"].includes(binding.purpose) || !id.test(binding.lease_id) || !id.test(binding.strategy_id) ||
      !hash.test(binding.contract_hash) || !commit.test(binding.base_commit) || !Number.isSafeInteger(binding.task_version) || binding.task_version < 1 ||
      binding.task_id !== task.id || binding.task_version !== task.task_version || binding.contract_hash !== task.contract_hash ||
      binding.base_commit !== task.workspace.commit || !task.strategies.some((strategy) => strategy.id === binding.strategy_id)) reject("artifact_binding_mismatch");
  if (binding.purpose === "checkpoint" && (!task.handoff.enabled || !task.handoff.allow_workspace_snapshot)) reject("artifact_handoff_disabled");
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Deliberately uncompressed, contiguous STORE ZIP: no descriptors, links,
// executable permissions, timestamps, extra fields, comments or ZIP64.
function zip(entries: { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "ascii"), bytes = Buffer.from(entry.bytes);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const centralSize = central.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  if (offset + centralSize + end.length > artifactLimits.archiveBytes) reject("artifact_archive_limit");
  return Buffer.concat([...local, ...central, end], offset + centralSize + end.length);
}

export async function buildArtifactBundle(taskValue: TaskContract, bindingValue: ArtifactBinding, supplied: readonly ArtifactFile[], scanner: ArtifactScanner): Promise<{ bytes: Buffer; sha256: string; size_bytes: number }> {
  let task: TaskContract;
  try { task = await validateTask(taskValue); }
  catch { return reject("artifact_task_invalid"); }
  const binding: ArtifactBinding = {
    purpose: bindingValue?.purpose, task_id: bindingValue?.task_id, task_version: bindingValue?.task_version,
    contract_hash: bindingValue?.contract_hash, lease_id: bindingValue?.lease_id, base_commit: bindingValue?.base_commit,
    strategy_id: bindingValue?.strategy_id,
  };
  validateBinding(task, binding);
  if (task.workspace.writable_paths.some((path) => !safeArtifactPath(path))) reject("artifact_path_denied");
  if (task.verification.forbidden_patterns.length > 256 || task.verification.forbidden_patterns.some((pattern) => !pattern || Buffer.byteLength(pattern, "utf8") > 4096)) reject("artifact_task_invalid");
  if (typeof scanner !== "function") reject("artifact_scanner_unavailable");
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > artifactLimits.files) reject("artifact_inventory_limit");
  const seen = new Set<string>();
  let contentBytes = 0;
  const files = supplied.map((file) => {
    if (!file || !safeArtifactPath(file.path) || !task.workspace.writable_paths.includes(file.path)) reject("artifact_path_denied");
    const lower = file.path.toLowerCase();
    if (seen.has(lower)) reject("artifact_duplicate_path");
    if ([...seen].some((path) => path.startsWith(lower + "/") || lower.startsWith(path + "/"))) reject("artifact_path_collision");
    seen.add(lower);
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > artifactLimits.fileBytes) reject("artifact_file_limit");
    contentBytes += file.bytes.byteLength;
    if (contentBytes > artifactLimits.archiveBytes) reject("artifact_archive_limit");
    const bytes = Buffer.from(file.bytes);
    const text = inspectArtifactText(bytes);
    if (task.verification.forbidden_patterns.some((pattern) => text.includes(pattern))) reject("artifact_forbidden_content");
    return { path: file.path, bytes, sha256: digest(bytes), size_bytes: bytes.length };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // Scanner gets private copies, so neither it nor caller mutations can change
  // the bytes whose hashes become the manifest and transport digest.
  try { await scanner(files.map((file) => ({ path: file.path, bytes: Uint8Array.from(file.bytes) }))); }
  catch { return reject("artifact_scan_failed"); }
  const manifest = Buffer.from(JSON.stringify({ format: "cg-artifact/1", ...binding, files: files.map(({ path, sha256, size_bytes }) => ({ path, sha256, size_bytes })) }), "utf8");
  if (manifest.length > artifactLimits.manifestBytes) reject("artifact_manifest_limit");
  const bytes = zip([{ name: "manifest.json", bytes: manifest }, ...files.map((file) => ({ name: `files/${file.path}`, bytes: file.bytes }))]);
  return { bytes, sha256: digest(bytes), size_bytes: bytes.length };
}
