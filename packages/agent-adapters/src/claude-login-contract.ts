// Browser-safe validation for the pinned official Claude subscription login.
// Authorization URLs and returned codes are transient user interaction data.
export const claudeLoginScopes = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins"] as const;
const keys = ["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"];
const opaque = /^[A-Za-z0-9_-]{43}$/;
function invalid(): never { throw new Error("profile_session_contract_invalid"); }
export function validateClaudeAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("https://claude.com/cai/oauth/authorize?") || /[\s\x00-\x1f\x7f\\]/.test(value)) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.origin !== "https://claude.com" || url.pathname !== "/cai/oauth/authorize" || url.username || url.password || url.port || url.hash ||
    value.slice(8, value.indexOf("/", 8)) !== "claude.com") invalid();
  const entries = [...url.searchParams];
  if (entries.length !== keys.length || new Set(entries.map(([key]) => key)).size !== keys.length || entries.some(([key, item]) => !keys.includes(key) || /[\x00-\x1f\x7f]/.test(item))) invalid();
  const params = url.searchParams;
  if (params.get("code") !== "true" || params.get("client_id") !== "9d1c250a-e61b-44d9-88ed-5944d1962f5e" || params.get("response_type") !== "code" ||
    params.get("redirect_uri") !== "https://platform.claude.com/oauth/code/callback" || params.get("code_challenge_method") !== "S256" ||
    !opaque.test(params.get("state")!) || !opaque.test(params.get("code_challenge")!)) invalid();
  const scopes = params.get("scope")!.split(" ");
  if (scopes.length !== claudeLoginScopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !(claudeLoginScopes as readonly string[]).includes(scope))) invalid();
  return value;
}
export function validateClaudeLoginCode(value: unknown, authorizationUrl?: string): string {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+#[A-Za-z0-9_-]{43}$/.test(value)) invalid();
  if (authorizationUrl !== undefined && value.split("#")[1] !== new URL(validateClaudeAuthorizationUrl(authorizationUrl)).searchParams.get("state")) invalid();
  return value;
}
