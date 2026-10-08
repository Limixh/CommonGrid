import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { codingCandidateSnapshotScript, validateCodingCandidateBytes, validateCodingCandidateSource } from "./coding-artifact.mjs";

test("bounded source permits normal code and UTF-8 without executing it", () => {
  const source = "// Türkçe örnek\nexport function sumIntegers(values) { return 0; }\n";
  assert.equal(validateCodingCandidateBytes(Buffer.from(source)), source);
  validateCodingCandidateSource(source);
  validateCodingCandidateSource(" ".repeat(16384));
});

test("binary, malformed UTF-8, hidden controls and oversized source are rejected", () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80])]) {
    assert.throws(() => validateCodingCandidateBytes(bytes), /candidate_invalid_utf8/);
  }
  for (const source of ["a\0b", "a\x1bb", "a\u202eb", "a\u2066b"]) {
    assert.throws(() => validateCodingCandidateSource(source), /candidate_unsafe_content/);
  }
  assert.throws(() => validateCodingCandidateSource("\ud800"), /candidate_invalid_utf8/);
  assert.throws(() => validateCodingCandidateSource(" ".repeat(16385)), /candidate_limit/);
});

const canaries = [
  "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_NOT_A_KEY\n-----END PRIVATE KEY-----",
  "AKIA" + "C".repeat(16),
  "ASIA" + "D".repeat(16),
  "sk-proj-" + "synthetic_canary_".repeat(3),
  "sk-ant-api03-" + "synthetic_canary_".repeat(3),
  "ghp_" + "C".repeat(40),
  "github_pat_" + "C".repeat(40),
  "xoxb-" + "1234567890-".repeat(3),
  "Bearer synthetic-canary-token-value",
  "eyJ" + "C".repeat(12) + "." + "D".repeat(12) + "." + "E".repeat(12),
  "postgres://fixture:synthetic_password@invalid.example/db",
  "const refresh_token = 'synthetic_canary_value';",
  'const settings = {"api_key":"synthetic_canary_value"};',
  "const password = `synthetic_canary_value`;",
];

test("synthetic credential shapes fail with codes that disclose no matched content", () => {
  for (const canary of canaries) {
    assert.throws(() => validateCodingCandidateSource(`/* ${canary} */\n`), error => {
      assert.equal(error.message, "candidate_secret_content");
      assert.ok(!error.message.includes(canary));
      return true;
    });
  }
  validateCodingCandidateSource("// access token checks belong outside sumIntegers\nexport const tokenCount = 0;\n");
});

// Run only the trusted exporter script, never the candidate. Remap its fixed
// /task path to a disposable local directory for filesystem-level tests.
function exportFixture(setup, intercept = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-artifact-unit-"));
  const directory = path.join(root, "task");
  fs.mkdirSync(directory);
  const output = [];
  const map = value => value === "/task" ? directory : value === "/task/sum.mjs" ? path.join(directory, "sum.mjs") : value;
  const fixtureFs = new Proxy(fs, { get(target, property) {
    if (property in intercept) return (...args) => intercept[property](target, map, ...args);
    // Node on Windows reports lstat.dev=0 but fstat.dev=the volume ID.
    // Normalize that platform quirk only in this Linux-exporter test facade.
    if (process.platform === "win32" && ["lstatSync", "fstatSync"].includes(property)) return (value, ...args) => {
      const stat = target[property](map(value), ...args); stat.dev = 0; return stat;
    };
    if (["readdirSync", "lstatSync", "openSync"].includes(property)) return (value, ...args) => target[property](map(value), ...args);
    return target[property];
  }});
  try {
    setup(directory);
    vm.runInNewContext(codingCandidateSnapshotScript, {
      require: name => { assert.equal(name, "node:fs"); return fixtureFs; },
      Buffer, TextDecoder, console: { log: value => output.push(value) },
    }, { timeout: 1000 });
    return output;
  } catch (error) {
    assert.deepEqual(output, [], "rejection must happen before candidate stdout");
    throw error;
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), "fixture_cleanup_scope");
    assert.ok(path.basename(resolved).startsWith("cg-artifact-unit-"), "fixture_cleanup_scope");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

test("exporter emits exactly the accepted file bytes", () => {
  const source = "export const sumIntegers = values => 0;\n";
  const output = exportFixture(directory => fs.writeFileSync(path.join(directory, "sum.mjs"), source));
  assert.deepEqual(output, [Buffer.from(source).toString("base64")]);
});

test("exporter rejects forbidden inventory and nonregular files", () => {
  for (const extra of [".env", ".git", "other.mjs"]) {
    assert.throws(() => exportFixture(directory => {
      fs.writeFileSync(path.join(directory, "sum.mjs"), "export const x = 0;");
      if (extra === ".git") fs.mkdirSync(path.join(directory, extra));
      else fs.writeFileSync(path.join(directory, extra), "synthetic");
    }), /artifact_inventory/);
  }
  assert.throws(() => exportFixture(directory => fs.mkdirSync(path.join(directory, "sum.mjs"))), /artifact_type/);
});

test("exporter rejects hardlink with no second entry inside task inventory", () => {
  assert.throws(() => exportFixture(directory => {
    fs.writeFileSync(path.join(directory, "target.mjs"), "export const x = 0;");
    fs.linkSync(path.join(directory, "target.mjs"), path.join(directory, "sum.mjs"));
    fs.renameSync(path.join(directory, "target.mjs"), path.join(directory, "../hardlink.mjs"));
  }), /artifact_type/);
});

test("opened-file replacement and growth are rejected before reading or exporting", () => {
  for (const change of ["replace", "grow"]) {
    assert.throws(() => exportFixture(directory => fs.writeFileSync(path.join(directory, "sum.mjs"), "export const x = 0;"), {
      openSync(target, map, filename, flags) {
        if (change === "replace") { target.unlinkSync(map(filename)); target.writeFileSync(map(filename), "replacement source"); }
        else target.appendFileSync(map(filename), " ".repeat(16385));
        return target.openSync(map(filename), flags);
      },
    }), /artifact_(?:changed|type)/);
  }
});

test("exporter rejects malformed bytes and synthetic secrets before emitting stdout", () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("a\0b"), Buffer.from(`// ${canaries[8]}\n`)]) {
    assert.throws(() => exportFixture(directory => fs.writeFileSync(path.join(directory, "sum.mjs"), bytes)), /candidate_(?:invalid_utf8|unsafe_content|secret_content)/);
  }
});

test("exporter read stays bounded if an external writer grows the opened file", () => {
  let requested = 0;
  assert.throws(() => exportFixture(directory => fs.writeFileSync(path.join(directory, "sum.mjs"), "export const x = 0;"), {
    readSync(target, map, fd, buffer, offset, length, position) {
      requested += length;
      target.appendFileSync(map("/task/sum.mjs"), " ".repeat(65536));
      return target.readSync(fd, buffer, offset, length, position);
    },
  }), /artifact_content/);
  assert.equal(requested, 16385);
});
