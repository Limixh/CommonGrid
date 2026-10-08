import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { root } from "./go.mjs";
const env = { ...process.env };
const temporary = path.join(root, ".tools/tmp");
mkdirSync(temporary, { recursive: true });
env.TEMP = temporary;
env.TMP = temporary;
env.TMPDIR = temporary;
const localCargo = path.join(root, ".tools/cargo");
if (existsSync(path.join(localCargo, "bin/cargo.exe"))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = path.join(root, ".tools/rustup");
  const pathKey =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] =
    path.join(localCargo, "bin") + path.delimiter + (env[pathKey] ?? "");
}
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const tauriBin = path.join(
  path.dirname(desktopRequire.resolve("@tauri-apps/cli/package.json")),
  "tauri.js",
);
const child = spawn(process.execPath, [tauriBin, ...process.argv.slice(2)], {
  cwd: path.join(root, "apps/desktop"),
  env,
  stdio: "inherit",
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
