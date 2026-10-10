// F0 loopback task broker. Reserve admission before reading an untrusted body.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

export function createTaskBroker({ token, execute }) {
  if (typeof token !== "string" || token.length !== 64 || !/^[a-f0-9]+$/.test(token) || typeof execute !== "function") {
    throw new Error("broker_configuration_invalid");
  }
  const expected = Buffer.from(`Bearer ${token}`);
  let active = false;
  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const reject = status => {
      response.writeHead(status, { connection: "close" }).end();
      request.resume();
    };
    if (request.method !== "POST" || request.url !== "/task") { reject(404); return; }
    const authorization = request.headers.authorization;
    const actual = typeof authorization === "string" ? Buffer.from(authorization) : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reject(401); return; }
    if (active) { reject(429); return; }
    active = true;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 49_152) { reject(413); return; }
        chunks.push(chunk);
      }
      const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
      const argumentsValue = JSON.parse(body);
      const result = await execute(argumentsValue);
      if (!response.destroyed) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      }
    } catch {
      if (!response.destroyed && !response.headersSent) reject(400);
    } finally { active = false; }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 16;
  return server;
}
