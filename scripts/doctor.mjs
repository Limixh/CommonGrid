import { spawnSync } from "node:child_process";
import { mkdir, writeFile, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probeTool } from "./tool-probes.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const probes = [
  ["codex", "Codex CLI"],
  ["claude", "Claude Code"],
  ["docker", "Docker"],
  ["podman", "Podman"],
  ["cargo", "Rust / Cargo"],
  ["go", "Go"],
];
function probe(name, label) {
  if (["codex", "claude", "docker", "podman"].includes(name)) {
    const result = probeTool(name, ["--version"]);
    let state = result.available ? "available" : "missing";
    if (result.available && ["docker", "podman"].includes(name) &&
        !probeTool(name, ["info", "--format", "{{.ServerVersion}}"] ).available)
      state = "not_running";
    return { id: name, label, state, version: result.stdout.trim().split(/\r?\n/)[0].slice(0, 160) || null };
  }
  let command = name;
  let args = ["--version"];
  const env = { ...process.env };
  if (
    name === "cargo" &&
    existsSync(new URL("../.tools/cargo/bin/cargo.exe", import.meta.url))
  ) {
    command = fileURLToPath(
      new URL("../.tools/cargo/bin/cargo.exe", import.meta.url),
    );
    env.CARGO_HOME = fileURLToPath(
      new URL("../.tools/cargo/", import.meta.url),
    );
    env.RUSTUP_HOME = fileURLToPath(
      new URL("../.tools/rustup/", import.meta.url),
    );
  }
  if (name === "go") {
    args = ["version"];
    if (existsSync(new URL("../.tools/go/bin/go.exe", import.meta.url)))
      command = fileURLToPath(
        new URL("../.tools/go/bin/go.exe", import.meta.url),
      );
  }
  const result = spawnSync(command, args, {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
          env,
        });
  let state = result.status === 0 ? "available" : "missing";
  const version =
    state === "available"
      ? result.stdout.trim().split(/\r?\n/)[0].slice(0, 160)
      : null;
  if (state === "available" && ["docker", "podman"].includes(name)) {
    const info = spawnSync(
      command,
      ["info", "--format", "{{.ServerVersion}}"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    if (info.status !== 0) state = "not_running";
  }
  return { id: name, label, state, version };
}
const report = {
  schema_version: "1.0",
  checked_at: new Date().toISOString(),
  platform: process.platform,
  checks: probes.map(([name, label]) => probe(name, label)),
  isolation_gate: "not_evaluated",
  execution_enabled: false,
};
mkdir(new URL("../.local/", import.meta.url), { recursive: true }, (err) => {
  if (err) throw err;
  writeFile(
    new URL("../.local/doctor.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
    (err) => {
      if (err) throw err;
      for (const check of report.checks)
        console.log(
          `${check.label.padEnd(16)} ${check.state.padEnd(12)} ${check.version ?? ""}`,
        );
      console.log(
        "Isolation gate: not_evaluated. Agent execution remains disabled.",
      );
    },
  );
});
