import { BlockList, isIPv4 } from "node:net";
export type SubscriptionProvider = "claude" | "codex";
// Exact HTTPS destinations, reviewed 2026-10-08. No wildcard, update/plugin,
// telemetry-only, user-supplied provider, plaintext HTTP or IP destination.
export const providerDestinations = {
  claude: ["api.anthropic.com", "claude.ai", "claude.com", "platform.claude.com"],
  codex: ["auth.openai.com", "chatgpt.com", "api.openai.com", "files.openai.com", "sdmntprcentralus.oaiusercontent.com", "sdmntprsouthcentralus.oaiusercontent.com"],
} as const;
export function providerHost(provider: SubscriptionProvider, authority: unknown): string {
  if (typeof authority !== "string" || authority.length > 257 || !/^[a-z0-9][a-z0-9.-]*:443$/.test(authority)) throw new Error("egress_denied");
  const hostname = authority.slice(0, -4);
  if (!(providerDestinations[provider] as readonly string[]).includes(hostname)) throw new Error("egress_denied");
  return hostname;
}
const denied = new BlockList();
for (const [network, bits] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) denied.addSubnet(network,bits,"ipv4");
export function publicIPv4(address: string): boolean { return isIPv4(address) && !denied.check(address,"ipv4"); }
export function checkedAddresses(addresses: string[]): string {
  if (!addresses.length || addresses.some(address => !publicIPv4(address))) throw new Error("egress_address_denied");
  return addresses[0]; // Connect this exact resolved address; no second DNS lookup.
}
