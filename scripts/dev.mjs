import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { root, goBinary, runGo } from "./go.mjs";
const probe = spawnSync(goBinary, ["version"], { encoding: "utf8" });
if (probe.status !== 0) {
  console.error(
    "Go bulunamadı. README kurulumunu izleyin; yalnız arayüz için npm run dev:ui.",
  );
  process.exit(1);
}
const api = runGo(["run", "./cmd/coordinator"]);
const desktopRequire = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const viteBin = path.join(
  path.dirname(desktopRequire.resolve("vite/package.json")),
  "bin/vite.js",
);
const children = [api];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  if (process.platform === "win32") {
    for (const child of children)
      if (child.pid)
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
        });
  } else {
    for (const child of children) child.kill("SIGTERM");
  }
  process.exitCode = code;
}
function supervise(child) {
  child.on("error", (err) => {
    console.error(err.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
supervise(api);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
// Don't render the first catalog before a cold Go build has finished.
let healthy = false;
for (let attempt = 0; attempt < 360 && !closing; attempt++) {
  try {
    const response = await fetch("http://127.0.0.1:8787/health", {
      signal: AbortSignal.timeout(1000),
    });
    const body = await response.json();
    if (response.ok && body.service === "coordinator") {
      healthy = true;
      break;
    }
  } catch {
    /* Coordinator is still compiling / binding. */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!healthy && !closing) {
  console.error("Koordinatör 90 saniye içinde hazır olmadı.");
  stop(1);
}
if (healthy && !closing) {
  const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1"], {
    cwd: path.join(root, "apps/desktop"),
    stdio: "inherit",
  });
  children.push(vite);
  supervise(vite);
}
