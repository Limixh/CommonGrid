import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createTaskBroker } from "../../spike/cli-session/task-broker.mjs";

const token = "f".repeat(64);
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("broker_test_deadline")), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(execute, check) {
  const server = createTaskBroker({ token, execute });
  server.listen(0, "127.0.0.1");await once(server, "listening");
  const port = server.address().port;
  try { await check(server, port); }
  finally { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
}
function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/task", headers: { authorization: `Bearer ${token}`, ...headers } }, response => {
      let text = "";response.on("data", chunk => text += chunk);
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    request.on("error", reject);request.end(body);
  });
}
test("broker reserves one slot before body reading and retains it until execution finishes", async () => {
  let calls = 0, finish, executionStarted;
  const started = new Promise(resolve => { executionStarted = resolve; });
  await fixture(async () => { calls++;return await new Promise(resolve => { finish = resolve;executionStarted(); }); }, async (server, port) => {
    const received = once(server, "request");
    const firstResult = new Promise((resolve, reject) => {
      const first = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/task", headers: { authorization: `Bearer ${token}` } }, response => { response.resume();response.on("end", () => resolve(response.statusCode)); });
      first.on("error", reject);first.write('{"argv":');
      received.then(async () => {
        try {
          assert.equal((await post(port, '{"argv":["second"]}')).status, 429);
          assert.equal(calls, 0);
          first.end('["first"]}');
        } catch (error) { first.destroy();reject(error); }
      });
    });
    firstResult.catch(() => {});
    await deadline(started);
    assert.equal((await post(port, '{"argv":["third"]}')).status, 429);
    assert.equal(calls, 1);finish({ exit_code: 0 });assert.equal(await firstResult, 200);
  });
});
test("an incomplete disconnected body releases admission without dispatching a task", async () => {
  let calls = 0;
  await fixture(async () => { calls++;return { exit_code: 0 }; }, async (server, port) => {
    const incoming = once(server, "request");
    const request = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/task", headers: { authorization: `Bearer ${token}` } });
    request.on("error", () => {});request.write("{");
    const [body] = await deadline(incoming), closed = new Promise(resolve => body.once("close", resolve));
    request.destroy();await deadline(closed);
    assert.equal((await post(port, '{"argv":["safe"]}')).status, 200);assert.equal(calls, 1);
  });
});
test("disconnect after dispatch keeps admission until the executor settles", async () => {
  let calls = 0, finish, executionStarted;
  const started = new Promise(resolve => { executionStarted = resolve; });
  await fixture(async () => {
    calls++;
    if(calls > 1)return { exit_code: 0 };
    return await new Promise(resolve => { finish = resolve;executionStarted(); });
  }, async (_server, port) => {
    const request = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/task", headers: { authorization: `Bearer ${token}` } });
    request.on("error", () => {});request.end('{"argv":["first"]}');await deadline(started);
    const closed = new Promise(resolve => request.once("close", resolve));request.destroy();await deadline(closed);
    assert.equal((await post(port, '{"argv":["second"]}')).status, 429);assert.equal(calls, 1);
    finish({ exit_code: 0 });assert.equal((await post(port, '{"argv":["third"]}')).status, 200);assert.equal(calls, 2);
  });
});
test("malformed, oversized, invalid UTF-8 and unauthorized bodies never reach execution", async () => {
  let calls = 0;
  await fixture(async () => { calls++;return { exit_code: 0 }; }, async (_server, port) => {
    assert.equal((await post(port, "{}", { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(port, "{bad-json")).status, 400);
    assert.equal((await post(port, Buffer.from([0x7b, 0xff, 0x7d]))).status, 400);
    assert.equal((await post(port, "a".repeat(49_153))).status, 413);
    assert.equal(calls, 0);
    assert.equal((await post(port, '{"argv":["safe"]}')).status, 200);
    assert.equal(calls, 1);
  });
});
test("a split multibyte argv survives bounded body decoding", async () => {
  let receivedArguments;
  await fixture(async value => { receivedArguments = value;return { exit_code: 0 }; }, async (_server, port) => {
    const encoded = Buffer.from('{"argv":["Türkçe"]}');
    const split = encoded.indexOf(Buffer.from("ü")) + 1;
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port, method: "POST", path: "/task", headers: { authorization: `Bearer ${token}` } }, response => { response.resume();response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);request.write(encoded.subarray(0, split));setImmediate(() => request.end(encoded.subarray(split)));
    });
    assert.equal(result, 200);assert.deepEqual(receivedArguments, { argv: ["Türkçe"] });
  });
});
