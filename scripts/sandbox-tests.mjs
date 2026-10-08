import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", "spike/sandbox/run.mts"], { cwd: root, stdio: "inherit", windowsHide: true });
child.on("error", () => { console.error("sandbox_test_launcher_failed"); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
