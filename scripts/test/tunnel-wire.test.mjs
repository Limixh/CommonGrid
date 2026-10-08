import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Frames, decodeData } from "../../spike/cli-session/tunnel-wire.mjs";
test("tunnel framing handles fragmented data and rejects oversized or truncated frames", async () => {
  const frames = new Frames(), values = []; frames.on("data",value=>values.push(value));
  frames.write(Buffer.from('{"kind":"data",'));frames.end(Buffer.from('"id":"1"}\n{"kind":"ready"}\n'));
  await once(frames,"finish");assert.deepEqual(values,[{kind:"data",id:"1"},{kind:"ready"}]);
  for(const input of ["x".repeat(65_537),'{"kind":"ready"}']) {
    const invalid=new Frames();const error=once(invalid,"error");invalid.end(Buffer.from(input));assert.match((await error)[0].message,/invalid|truncated/);
  }
});
test("tunnel accepts bounded binary chunks but rejects ambiguous or oversized base64",()=>{
  assert.deepEqual(decodeData(Buffer.from([0,255,1]).toString("base64")),Buffer.from([0,255,1]));
  for(const value of ["!","YQ","YQ==\n","a".repeat(32_772),null])assert.throws(()=>decodeData(value));
});
