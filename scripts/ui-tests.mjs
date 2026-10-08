import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { root } from "./go.mjs";
const temporary = path.join(root, ".tools/tmp");
mkdirSync(temporary, { recursive: true });
const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".tools/browsers"),
  PLAYWRIGHT_SKIP_BROWSER_GC: "1",
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
};
const args = process.argv.slice(2);
const child = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/@playwright/test/cli.js"),
    ...(args.length ? args : ["test"]),
  ],
  { cwd: root, env, stdio: "inherit" },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
