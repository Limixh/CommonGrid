import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { root } from "./go.mjs";
import { rustEnvironment } from "./rust.mjs";
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const tauriBin = path.join(
  path.dirname(desktopRequire.resolve("@tauri-apps/cli/package.json")),
  "tauri.js",
);
const child = spawn(process.execPath, [tauriBin, ...process.argv.slice(2)], {
  cwd: path.join(root, "apps/desktop"),
  env: rustEnvironment(),
  stdio: "inherit",
  windowsHide: true,
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
