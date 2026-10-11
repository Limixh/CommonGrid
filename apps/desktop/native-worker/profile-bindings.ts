import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type SessionProvider = "codex" | "claude";
export interface ProfileBinding { schema_version: "1.0"; profile_id: string; provider: SessionProvider; owner: string; state: "reserved" | "ready" }
export class BindingFailure extends Error {
  constructor(readonly code: "profile_invalid" | "profile_needs_review") { super(code); }
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateBinding(value: unknown, profileId: string, provider: SessionProvider): ProfileBinding {
  const binding = value as ProfileBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
    Object.keys(binding).sort().join() !== "owner,profile_id,provider,schema_version,state" ||
    binding.schema_version !== "1.0" || binding.profile_id !== profileId || binding.provider !== provider ||
    !uuid.test(binding.profile_id) || typeof binding.owner !== "string" || !uuid.test(binding.owner) || binding.owner === profileId ||
    !["reserved", "ready"].includes(binding.state)) throw new BindingFailure("profile_invalid");
  return {...binding};
}
async function ancestors(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BindingFailure("profile_invalid");
  const parent = path.dirname(directory);
  if (parent !== directory) await ancestors(parent);
}
/** Public app profile binding only. The private CLI home never enters this store. */
export class ProfileBindings {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root) || /[\0\r\n]/.test(root)) throw new BindingFailure("profile_invalid");
  }
  private filename(profileId: string) {
    if (!uuid.test(profileId)) throw new BindingFailure("profile_invalid");
    return path.join(this.root, `${profileId}.json`);
  }
  private async directory(create = false) {
    await ancestors(path.dirname(this.root)).catch(() => { throw new BindingFailure("profile_invalid"); });
    if (create) {
      await mkdir(this.root, {recursive: false}).catch(error => { if (error.code !== "EEXIST") throw error; });
    }
    await ancestors(this.root);
  }
  async read(profileId: string, provider: SessionProvider): Promise<ProfileBinding | undefined> {
      const filename = this.filename(profileId);
    try {
      await this.directory();
      const before = await lstat(filename, {bigint: true});
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) throw new BindingFailure("profile_invalid");
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat({bigint: true}), after = await lstat(filename, {bigint: true});
        // Node on Windows reports lstat.dev=0 for regular paths but fstat.dev
        // contains the volume serial. Compare exact inode and both path views;
        // POSIX additionally requires the device identity to match.
        if (!stat.isFile() || stat.nlink !== 1n || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
          stat.ino !== before.ino || after.ino !== before.ino || after.dev !== before.dev ||
          (process.platform !== "win32" && stat.dev !== before.dev) || stat.size > 4096n || after.size > 4096n) throw new BindingFailure("profile_invalid");
        const bytes = Buffer.alloc(4097), result = await file.read(bytes, 0, bytes.length, 0);
        if (result.bytesRead > 4096) throw new BindingFailure("profile_invalid");
        return validateBinding(JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")), profileId, provider);
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error instanceof BindingFailure ? error : new BindingFailure("profile_invalid");
    }
  }
  async reserve(profileId: string, provider: SessionProvider): Promise<ProfileBinding> {
    await this.directory(true);
    const binding: ProfileBinding = {schema_version: "1.0", profile_id: profileId, provider, owner: randomUUID(), state: "reserved"};
    validateBinding(binding, profileId, provider);
    const file = await open(this.filename(profileId), "wx", 0o600).catch(() => { throw new BindingFailure("profile_needs_review"); });
    try { await file.writeFile(JSON.stringify(binding) + "\n"); await file.sync(); await file.close(); }
    catch { throw new BindingFailure("profile_needs_review"); }
    finally { await file.close().catch(() => {}); }
    return binding;
  }
  private async assertOwned(binding: ProfileBinding) {
    const current = await this.read(binding.profile_id, binding.provider);
    if (!current || current.owner !== binding.owner || current.state !== binding.state) throw new BindingFailure("profile_needs_review");
  }
  async ready(binding: ProfileBinding): Promise<ProfileBinding> {
    validateBinding(binding, binding.profile_id, binding.provider);
    if (binding.state !== "reserved") throw new BindingFailure("profile_needs_review");
    await this.assertOwned(binding);
    const next = {...binding, state: "ready" as const}, temporary = path.join(this.root, `.binding-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(next) + "\n"); await file.sync(); await file.close();
      await this.assertOwned(binding); await rename(temporary, this.filename(binding.profile_id));
      await this.assertOwned(next); return next;
    } finally { await file.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async removeReserved(binding: ProfileBinding): Promise<void> {
    if (binding.state !== "reserved") throw new BindingFailure("profile_needs_review");
    await this.assertOwned(binding); await unlink(this.filename(binding.profile_id));
  }
}
