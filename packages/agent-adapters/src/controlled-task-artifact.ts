// Narrow, bounded safety policy for the controlled sum.mjs task only.
// This is not an archive/repository importer or a complete secret scanner.
export const controlledCandidateLimit = 16_384;

// The validator source is also executed inside the read-only exporter
// container, so its body must stay self-contained (no helpers, no closures).
export function validateControlledCandidateBytes(bytes: Uint8Array): string {
  if (bytes.length > 16_384) throw new Error("candidate_limit");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("candidate_invalid_utf8"); }
  // Allow normal source whitespace, but reject binary/control bytes and bidi
  // overrides that can conceal source or credential text in the exported diff.
  // Built from an escaped string so transpilers cannot print literal bidi
  // characters into the exporter script that embeds this function's source.
  if (new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]", "u").test(source)) {
    throw new Error("candidate_unsafe_content");
  }
  // Known credential shapes plus literal credential assignments. No matched
  // bytes, excerpts, or provider responses are placed in rejection messages.
  const patterns = [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/'"@:]+:[^\s/'"@]+@/i,
    /["'`]?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)["'`]?\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(source)) throw new Error("candidate_secret_content");
  }
  return source;
}

export function validateControlledCandidateSource(source: string): void {
  const bytes = new TextEncoder().encode(source);
  const decoded = validateControlledCandidateBytes(bytes);
  // String callers must not silently replace unpaired UTF-16 surrogates.
  if (decoded !== source) throw new Error("candidate_invalid_utf8");
}

// The readonly Linux exporter runs this trusted script while task processes
// are paused. Checks happen before stdout receives any candidate bytes.
export const controlledCandidateSnapshotScript = `
const f = require('node:fs');
const validate = (${validateControlledCandidateBytes.toString()});
const names = f.readdirSync('/task');
if (names.length !== 1 || names[0] !== 'sum.mjs') throw Error('artifact_inventory');
const p = '/task/sum.mjs';
function safe(s) {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16384) throw Error('artifact_type');
}
function same(a, b) {
  if (a.dev !== b.dev || a.ino !== b.ino || a.mode !== b.mode || a.nlink !== b.nlink || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) throw Error('artifact_changed');
}
const before = f.lstatSync(p); safe(before);
const fd = f.openSync(p, f.constants.O_RDONLY | f.constants.O_NOFOLLOW | f.constants.O_NONBLOCK);
try {
  const opened = f.fstatSync(fd); safe(opened); same(before, opened);
  const buffer = Buffer.alloc(16385);
  let used = 0;
  while (used < buffer.length) {
    const count = f.readSync(fd, buffer, used, buffer.length - used, null);
    if (count === 0) break;
    used += count;
  }
  if (used > 16384 || used !== opened.size) throw Error('artifact_content');
  const after = f.fstatSync(fd); safe(after); same(opened, after);
  const linked = f.lstatSync(p); safe(linked); same(after, linked);
  const bytes = buffer.subarray(0, used); validate(bytes);
  console.log(bytes.toString('base64'));
} finally { f.closeSync(fd); }
`;

export interface TaskSnapshotFile { path: string; /** Pinned digest of a protected file; null marks the one writable file. */ sha256: string | null }
export interface TaskSnapshotSpec { files: readonly TaskSnapshotFile[] }
const snapshotPath = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

// Multi-file variant for tasks whose agent workspace is a small pinned tree.
// The exporter walks /task with lstat only and rejects before stdout unless the
// regular-file set equals the manifest and the directories are exactly the
// manifest's parents. Protected files must match their pinned digest; only the
// writable file passes the candidate content policy and is printed (base64).
export function taskCandidateSnapshotScript(spec: TaskSnapshotSpec): string {
  const paths = spec.files.map(file => file.path);
  if (!spec.files.length || spec.files.length > 16 || new Set(paths).size !== paths.length ||
    !paths.every(path => snapshotPath.test(path) && path.split("/").every(part => part !== "." && part !== "..")) ||
    spec.files.filter(file => file.sha256 === null).length !== 1 ||
    !spec.files.every(file => file.sha256 === null || /^[0-9a-f]{64}$/.test(file.sha256))) throw new Error("task_snapshot_spec_invalid");
  return `
const f = require('node:fs'), crypto = require('node:crypto');
const spec = ${JSON.stringify({files: spec.files.map(file => ({path: file.path, sha256: file.sha256}))})};
const validate = (${validateControlledCandidateBytes.toString()});
const limit = 16384;
const expected = new Map(spec.files.map(file => [file.path, file.sha256]));
const dirs = new Set();
for (const path of expected.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
function safe(s) {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit) throw Error('candidate_type');
}
function same(a, b) {
  if (a.dev !== b.dev || a.ino !== b.ino || a.mode !== b.mode || a.nlink !== b.nlink || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) throw Error('candidate_changed');
}
const seen = new Set();
function walk(rel) {
  const names = f.readdirSync(rel ? '/task/' + rel : '/task');
  if (names.length > 32) throw Error('candidate_inventory');
  for (const name of names) {
    const path = rel ? rel + '/' + name : name, s = f.lstatSync('/task/' + path);
    if (s.isDirectory() && !s.isSymbolicLink()) { if (!dirs.has(path)) throw Error('candidate_inventory'); walk(path); continue; }
    safe(s);
    if (!expected.has(path)) throw Error('candidate_inventory');
    seen.add(path);
  }
}
walk('');
if (seen.size !== expected.size) throw Error('candidate_inventory');
function read(path) {
  const p = '/task/' + path;
  const before = f.lstatSync(p); safe(before);
  const fd = f.openSync(p, f.constants.O_RDONLY | f.constants.O_NOFOLLOW | f.constants.O_NONBLOCK);
  try {
    const opened = f.fstatSync(fd); safe(opened); same(before, opened);
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = f.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > limit || used !== opened.size) throw Error('candidate_content');
    const after = f.fstatSync(fd); safe(after); same(opened, after);
    const linked = f.lstatSync(p); safe(linked); same(after, linked);
    return buffer.subarray(0, used);
  } finally { f.closeSync(fd); }
}
let output;
for (const [path, digest] of expected) {
  const bytes = read(path);
  if (digest === null) { validate(bytes); output = bytes; }
  else if (crypto.createHash('sha256').update(bytes).digest('hex') !== digest) throw Error('candidate_protected_changed');
}
console.log(output.toString('base64'));
`;
}
