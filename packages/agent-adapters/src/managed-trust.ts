// Explicit public-root opt-in for one managed profile; no OS trust discovery.
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const purpose = "managed_claude_optional_public_root";
const endpoint = "api.anthropic.com:443";
const source = "operator_verified_tls_chain_and_installed_root";
const maxProofAge = 30 * 24 * 60 * 60 * 1000;
export interface ManagedHostTrustOptions { pemPath: string; proofPath: string }
export interface ManagedProfileTrust {
  schema_version: "1.0";
  kind: "optional_public_root";
  profile_owner: string;
  purpose: typeof purpose;
  endpoint: typeof endpoint;
  source: typeof source;
  checked_at: string;
  certificate_sha256: string;
  pem_sha256: string;
}
export function assertManagedProfileTrust(value: unknown, owner: string, provider: string): asserts value is ManagedProfileTrust {
  // Saved metadata is untrusted. AssertionError includes actual/expected
  // payloads in uncaught failures, so expose only fixed diagnostic codes.
  const trust = value as ManagedProfileTrust;
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) throw new Error("managed_profile_trust_invalid");
  if (provider !== "claude") throw new Error("managed_profile_trust_provider_invalid");
  if (trust.schema_version !== "1.0" || trust.kind !== "optional_public_root") throw new Error("managed_profile_trust_invalid");
  if (trust.profile_owner !== owner) throw new Error("managed_profile_trust_owner_mismatch");
  if (trust.purpose !== purpose) throw new Error("managed_profile_trust_purpose_invalid");
  if (trust.endpoint !== endpoint) throw new Error("managed_profile_trust_endpoint_invalid");
  if (trust.source !== source) throw new Error("managed_profile_trust_source_invalid");
  if (typeof trust.checked_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(trust.checked_at) || !Number.isFinite(Date.parse(trust.checked_at)) || new Date(trust.checked_at).toISOString().slice(0,19) !== trust.checked_at.slice(0,19)) throw new Error("managed_profile_trust_date_invalid");
  if (typeof trust.certificate_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(trust.certificate_sha256) || typeof trust.pem_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(trust.pem_sha256)) throw new Error("managed_profile_trust_hash_invalid");
  const fields = ["schema_version", "kind", "profile_owner", "purpose", "endpoint", "source", "checked_at", "certificate_sha256", "pem_sha256"];
  if (Object.keys(trust).length !== fields.length || Object.keys(trust).some(key => !fields.includes(key))) throw new Error("managed_profile_trust_invalid");
}
export function validateManagedHostTrust(pem: string, value: unknown, owner: string, now = Date.now()) {
  try {
    const proof = value as Record<string, unknown>;
    assert.ok(proof && typeof proof === "object" && !Array.isArray(proof), "managed_host_trust_proof_invalid");
    assert.equal(proof.windows_tls_verified, true);
    assert.equal(proof.installed_root, true);
    assert.equal(proof.private_key_exported, false);
    const trust: ManagedProfileTrust = {schema_version:"1.0", kind:"optional_public_root", profile_owner:owner, purpose:proof.purpose as typeof purpose, endpoint:proof.endpoint as typeof endpoint, source:proof.source as typeof source, checked_at:proof.checked_at as string, certificate_sha256:proof.certificate_sha256 as string, pem_sha256:proof.pem_sha256 as string};
    assertManagedProfileTrust(trust, owner, "claude");
    const checked = Date.parse(trust.checked_at);
    assert.ok(Number.isFinite(now) && checked <= now && now - checked <= maxProofAge, "managed_host_trust_proof_expired");
    assert.ok(typeof pem === "string" && pem.length <= 32_768 && /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(pem), "managed_host_trust_pem_invalid");
    const certificate = new X509Certificate(pem);
    assert.equal(hash(certificate.raw), trust.certificate_sha256);
    assert.equal(hash(pem), trust.pem_sha256);
    assert.equal(certificate.ca, true);
    assert.equal(certificate.subject, certificate.issuer);
    assert.equal(certificate.verify(certificate.publicKey), true);
    assert.ok(Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) >= now, "managed_host_trust_certificate_expired");
    return {pem, trust};
  } catch { throw new Error("managed_host_trust_invalid"); }
}
export async function readManagedHostTrust(options: ManagedHostTrustOptions, owner: string) {
  assert.ok(options && typeof options.pemPath === "string" && options.pemPath.length > 0 && typeof options.proofPath === "string" && options.proofPath.length > 0, "managed_host_trust_selection_required");
  try { return validateManagedHostTrust(await readFile(options.pemPath, "utf8"), JSON.parse(await readFile(options.proofPath, "utf8")), owner); }
  catch { throw new Error("managed_host_trust_invalid"); }
}

// Used with the pinned image and tools volume only. Existing bytes are never
// silently replaced, and the persisted selection is bound to its profile.
export const installManagedHostTrustScript = "const f=require('node:fs'),pem=process.argv[1],manifest=process.argv[2],bundle=require('node:tls').rootCertificates.join('\\n')+'\\n'+pem,files=[['optional-public-root.pem',pem],['optional-public-ca.pem',bundle],['profile-trust.json',manifest]];for(const [name,value]of files){if(f.existsSync('/opt/cg/'+name)&&f.readFileSync('/opt/cg/'+name,'utf8')!==value)throw Error('profile_trust_mismatch');}f.chmodSync('/opt/cg',0o755);try{for(const [name,value]of files)if(!f.existsSync('/opt/cg/'+name))f.writeFileSync('/opt/cg/'+name,value,{flag:'wx',mode:0o444});}finally{f.chmodSync('/opt/cg',0o555);}";
export const verifyManagedHostTrustScript = "const f=require('node:fs'),c=require('node:crypto'),trust=JSON.parse(process.argv[1]),pem=f.readFileSync('/opt/cg/optional-public-root.pem','utf8'),certificate=new c.X509Certificate(pem),h=value=>c.createHash('sha256').update(value).digest('hex');console.log(f.readFileSync('/opt/cg/profile-trust.json','utf8')===process.argv[1]&&h(pem)===trust.pem_sha256&&h(certificate.raw)===trust.certificate_sha256&&certificate.ca&&certificate.subject===certificate.issuer&&certificate.verify(certificate.publicKey)&&Date.parse(certificate.validFrom)<=Date.now()&&Date.parse(certificate.validTo)>=Date.now()&&f.readFileSync('/opt/cg/optional-public-ca.pem','utf8')===require('node:tls').rootCertificates.join('\\n')+'\\n'+pem);";
