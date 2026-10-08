// Narrow, bounded safety policy for the sum.mjs acceptance fixture only.
// This is not an archive/repository importer or a complete secret scanner.
export const codingCandidateLimit = 16_384;

/** @param {Buffer} bytes @returns {string} */
export function validateCodingCandidateBytes(bytes) {
  if (bytes.length > 16_384) throw new Error("candidate_limit");
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("candidate_invalid_utf8"); }
  // Allow normal source whitespace, but reject binary/control bytes and bidi
  // overrides that can conceal source or credential text in the exported diff.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(source)) {
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

/** @param {string} source @returns {void} */
export function validateCodingCandidateSource(source) {
  const bytes = Buffer.from(source, "utf8");
  const decoded = validateCodingCandidateBytes(bytes);
  // String callers must not silently replace unpaired UTF-16 surrogates.
  if (decoded !== source) throw new Error("candidate_invalid_utf8");
}

// The readonly Linux exporter runs this trusted script while task processes
// are paused. Checks happen before stdout receives any candidate bytes.
export const codingCandidateSnapshotScript = `
const f = require('node:fs');
const validate = (${validateCodingCandidateBytes.toString()});
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
