// Internal F0 task-tools runtime. No CLI, credentials, HTTP route or model calls.
import { randomUUID } from "node:crypto";
import { describeTaskContainer, type TaskSandboxSpec } from "./index.ts";
import { runOwnedCommand, CommandError as DockerCommandError, type CommandOptions, type CommandResult } from "./owned-process.ts";
export { DockerCommandError };
export type DockerResult = CommandResult;

// Task text never reaches a host shell or chooses the launcher executable.
export function dockerCommand(args: string[], options: CommandOptions = {}): Promise<DockerResult> {
  return runOwnedCommand("docker", args, options);
}

async function checked(args: string[], timeoutMs = 10_000): Promise<string> {
  const result = await dockerCommand(args, { timeoutMs });
  if (result.code !== 0) throw new DockerCommandError("failed");
  return result.stdout.trim();
}

export class TaskToolsRuntime {
  readonly owner = randomUUID();
  readonly volume = `cg-workspace-${this.owner}`;
  readonly container = `cg-task-${this.owner}`;
  private readonly initContainer = `cg-init-${this.owner}`;
  private closed = false;
  private busy = false;
  private readonly label: string;
  private constructor() { this.label = `io.commongrid.spike.owner=${this.owner}`; }

  static async create(spec: Omit<TaskSandboxSpec, "workspaceVolume">, lifetimeMs = 120_000) {
    if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 600_000)
      throw new Error("invalid sandbox lifetime");
    const runtime = new TaskToolsRuntime();
    const args = describeTaskContainer({ ...spec, workspaceVolume: runtime.volume });
    try {
      await checked(["volume", "create", "--label", runtime.label, runtime.volume]);
      // Trusted one-shot initialization of a new empty opaque volume. This is
      // the only root operation; it cannot mount host paths or auth state.
      await checked(["run", "--name", runtime.initContainer, "--label", runtime.label,
        "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN",
        "--security-opt", "no-new-privileges", "--pids-limit", "16", "--cpus", "1", "--memory", "128m",
        "--mount", `type=volume,src=${runtime.volume},dst=/task,volume-nocopy`, spec.image,
        "/bin/chown", "65532:65532", "/task"]);
      await checked(["rm", runtime.initContainer]);
      await checked([...args.slice(0, -1), "--name", runtime.container, "--label", runtime.label, "--init", args.at(-1)!,
        "node", "-e", `setTimeout(() => process.exit(0), ${lifetimeMs})`]);
      await checked(["start", runtime.container]);
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async inspect(): Promise<Record<string, any>> {
    await this.verifyContainer(this.container);
    const result = await checked(["inspect", this.container]);
    return JSON.parse(result)[0];
  }

  async exec(command: string[], options: { timeoutMs?: number; signal?: AbortSignal; maxBytes?: number } = {}) {
    if (this.closed || this.busy) throw new Error("sandbox_unavailable");
    if (!command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error("invalid sandbox command");
    const timeoutMs = options.timeoutMs ?? 3000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
      throw new Error("invalid command deadline");
    if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1_048_576))
      throw new Error("invalid output bound");
    this.busy = true;
    try {
      await this.verifyContainer(this.container);
      return await dockerCommand(["exec", "--workdir", "/task", this.container, ...command], { ...options, timeoutMs });
    } catch (error) {
      // Timeout/abort/output overflow terminate the namespace, not just the
      // Docker client. No further command may reuse this stopped environment.
      await this.close();
      throw error;
    } finally { this.busy = false; }
  }

  private async verifyContainer(name: string) {
    const owner = await checked(["inspect", "--format", '{{index .Config.Labels "io.commongrid.spike.owner"}}', name]);
    if (owner !== this.owner) throw new Error("sandbox_owner_mismatch");
  }

  async close() {
    this.closed = true;
    const failures: Error[] = [];
    for (const name of [this.container, this.initContainer]) {
      const listed = await dockerCommand(["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
      if (listed.code !== 0) { failures.push(new Error("sandbox_cleanup_unconfirmed")); continue; }
      if (!listed.stdout.trim().split(/\r?\n/).includes(name)) continue;
      try { await this.verifyContainer(name); }
      catch { failures.push(new Error("sandbox_owner_mismatch")); continue; }
      const removed = await dockerCommand(["rm", "--force", name]);
      if (removed.code !== 0) failures.push(new Error("sandbox_cleanup_failed"));
    }
    const volumes = await dockerCommand(["volume", "ls", "--filter", `name=${this.volume}`, "--format", "{{.Name}}"]);
    if (volumes.code !== 0) failures.push(new Error("sandbox_cleanup_unconfirmed"));
    else if (volumes.stdout.trim().split(/\r?\n/).includes(this.volume)) {
      const found = await dockerCommand(["volume", "inspect", "--format", '{{index .Labels "io.commongrid.spike.owner"}}', this.volume]);
      if (found.code !== 0) { failures.push(new Error("sandbox_cleanup_unconfirmed")); }
      else if (found.stdout.trim() !== this.owner) failures.push(new Error("sandbox_owner_mismatch"));
      else if ((await dockerCommand(["volume", "rm", this.volume])).code !== 0) failures.push(new Error("sandbox_cleanup_failed"));
    }
    if (failures.length) throw new AggregateError(failures, "sandbox_cleanup_failed");
  }
}
