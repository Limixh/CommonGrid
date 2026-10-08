import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedAddresses, providerHost, publicIPv4 } from "../src/egress-policy.ts";
test("provider egress denies deceptive authority, private endpoints and other provider", () => {
  assert.equal(providerHost("codex", "auth.openai.com:443"), "auth.openai.com");
  assert.equal(providerHost("claude", "platform.claude.com:443"), "platform.claude.com");
  for (const target of ["auth.openai.com.evil.test:443","auth.openai.com:80","auth.openai.com.:443","auth.openai.com@127.0.0.1:443","127.0.0.1:443","[::1]:443","AUTH.OPENAI.COM:443","api.anthropic.com:443","auth.openai.com:443/path"]) assert.throws(() => providerHost("codex",target));
});
test("DNS rebinding and mixed public/private answers fail before connection", () => {
  assert.equal(checkedAddresses(["1.1.1.1"]), "1.1.1.1");
  for (const address of ["0.0.0.0","10.2.3.4","100.64.0.1","127.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","198.18.0.1","224.0.0.1","255.255.255.255","::1","::ffff:127.0.0.1"]) { assert.equal(publicIPv4(address),false); assert.throws(() => checkedAddresses(["1.1.1.1",address])); }
  assert.throws(() => checkedAddresses([]));
});
