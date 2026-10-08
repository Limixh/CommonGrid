import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const root = fileURLToPath(new URL("../", import.meta.url));
export const goBinary = existsSync(path.join(root, ".tools/go/bin/go.exe"))
  ? path.join(root, ".tools/go/bin/go.exe")
  : "go";
export function runGo(args, options = {}) {
  return spawn(goBinary, args, {
    cwd: path.join(root, "services/coordinator"),
    stdio: "inherit",
    ...options,
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = runGo(process.argv.slice(2));
  child.on("error", (err) => {
    console.error(
      `Go çalıştırılamadı: ${err.message}. README'deki kurulumu izleyin.`,
    );
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
