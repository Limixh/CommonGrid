// Bounded JSON frames for a trusted stdio TLS tunnel. Payloads are never logged.
import { Transform } from "node:stream";
export const FRAME_BYTES = 65_536;
export const DATA_BYTES = 24_576;
export class Frames extends Transform {
  constructor() { super({ readableObjectMode: true }); this.pending = Buffer.alloc(0); }
  _transform(chunk, encoding, callback) {
    try {
      let offset = 0;
      for (let end; (end = chunk.indexOf(10, offset)) !== -1; offset = end + 1) {
        if (this.pending.length + end - offset > FRAME_BYTES) throw new Error("frame_limit");
        const line = Buffer.concat([this.pending, chunk.subarray(offset, end)]);
        this.pending = Buffer.alloc(0);
        if (line.length) this.push(JSON.parse(line.toString("utf8")));
      }
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset)]);
      if (this.pending.length > FRAME_BYTES) throw new Error("frame_limit");
      callback();
    } catch { callback(new Error("invalid_tunnel_frame")); }
  }
  _flush(callback) { callback(this.pending.length ? new Error("truncated_tunnel_frame") : undefined); }
}
export function decodeData(value) {
  if (typeof value !== "string" || value.length > DATA_BYTES * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid_tunnel_data");
  return Buffer.from(value, "base64");
}
export function sendFrame(stream, value) {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) > FRAME_BYTES) throw new Error("frame_limit");
  return stream.write(frame);
}
export function sendData(stream, id, bytes) {
  let writable = true;
  for (let i = 0; i < bytes.length; i += DATA_BYTES) writable = sendFrame(stream, { kind: "data", id, data: bytes.subarray(i, i + DATA_BYTES).toString("base64") }) && writable;
  return writable;
}
