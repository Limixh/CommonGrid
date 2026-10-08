// Version/help probes only. Never accept a task command or credential path here.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const supported = new Set(["codex", "claude", "docker", "podman"]);
export function probeTool(name, args, options = {}) {
  if (!supported.has(name) || !args.every((arg) => typeof arg === "string"))
    throw new Error("unsupported tool probe");
  const allowedArgs = [["--version"], ["--help"]];
  if (name === "codex") allowedArgs.push(["exec", "--help"]);
  if (["docker", "podman"].includes(name)) allowedArgs.push(["info", "--format", "{{.ServerVersion}}"]);
  if (!allowedArgs.some((allowed) => allowed.length === args.length && allowed.every((value, index) => args[index] === value)))
    throw new Error("unsupported tool probe arguments");
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const run = options.run ?? spawnSync;
  let command = name;
  let commandArgs = args;
  let resolution = "path";
  if (platform === "win32" && name === "claude" && env.USERPROFILE) {
    const native = path.win32.join(env.USERPROFILE, ".local", "bin", "claude.exe");
    if (exists(native)) { command = native; resolution = "native_install"; }
  }
  if (platform === "win32" && command === name && ["claude", "codex"].includes(name)) {
    // Legacy npm shims need cmd. Only this closed set of read-only arguments can
    // cross that shell boundary; native binaries use argument arrays directly.
    const allowed = new Set(["--version", "--help", "exec"]);
    if (!args.length || !args.every((arg) => allowed.has(arg)))
      throw new Error("unsupported shim probe arguments");
    command = "cmd.exe";
    commandArgs = ["/d", "/s", "/c", `${name} ${args.join(" ")}`];
    resolution = "npm_shim";
  }
  const result = run(command, commandArgs, {
    encoding: "utf8", timeout: 10_000, windowsHide: true, env, maxBuffer: 1_048_576,
  });
  return {
    available: result.status === 0,
    stdout: result.status === 0 ? result.stdout ?? "" : "",
    resolution,
  };
}
