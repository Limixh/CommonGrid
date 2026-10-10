import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { operationStatusMiddleware } from "./operation-status-server.ts";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-readiness-report",
      configureServer(server) {
        server.middlewares.use("/local-operation-status", operationStatusMiddleware(fileURLToPath(new URL("../../.local/managed-operation-journal", import.meta.url))));
        server.middlewares.use("/local-readiness", async (_req, res) => {
          try {
            const report = await readFile(
              new URL("../../.local/doctor.json", import.meta.url),
              "utf8",
            );
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(report);
          } catch {
            res.statusCode = 503;
            res.end(JSON.stringify({ code: "doctor_not_run" }));
          }
        });
      },
    },
  ],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**", "**/src-tauri/gen/**"] },
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  clearScreen: false,
});
