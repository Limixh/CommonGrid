import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { root } from "./go.mjs";

/** Share the configured Rust toolchain and temp directory with Tauri and Cargo. */
export function rustEnvironment(source = process.env) {
  const env = { ...source };
  const temporary = path.join(root, ".tools/tmp");
  mkdirSync(temporary, { recursive: true });
  env.TEMP = temporary;
  env.TMP = temporary;
  env.TMPDIR = temporary;
  const localCargo = path.join(root, ".tools/cargo");
  if (existsSync(path.join(localCargo, "bin/cargo.exe"))) {
    env.CARGO_HOME = localCargo;
    env.RUSTUP_HOME = path.join(root, ".tools/rustup");
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = path.join(localCargo, "bin") + path.delimiter + (env[pathKey] ?? "");
  }
  return env;
}

export function runRust(args, options = {}) {
  return spawn("cargo", args, {
    cwd: path.join(root, "apps/desktop/src-tauri"),
    env: rustEnvironment(),
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!["fmt", "clippy", "--version", "version"].includes(process.argv[2])) {
    const { prepareNativeLauncher } = await import("./native-launcher-assets.mjs");
    await prepareNativeLauncher();
  }
  const child = runRust(process.argv.slice(2));
  child.on("error", () => { console.error("Rust toolchain unavailable; follow docs/DEVELOPMENT.md."); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
