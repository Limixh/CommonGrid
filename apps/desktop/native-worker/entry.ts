import { parseBoot, runCliCheck, type Frame } from "./cli-check.ts";

// Nothing runs before the native supervisor has assigned process ownership and
// supplied one bounded boot frame. EOF is a cooperative cancellation request.
const controller = new AbortController();
let buffer = Buffer.alloc(0), started = false, finished = false;
let deadline: NodeJS.Timeout | undefined;
const emit = (frame: Frame) => { if (!finished) process.stdout.write(JSON.stringify(frame) + "\n"); };
const fail = () => {
  if (started) controller.abort("worker_failed");
  else { finished = true; process.exitCode = 1; process.stdin.destroy(); }
};
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 8192) { fail(); return; }
  let newline: number;
  while ((newline = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, newline).toString("utf8"); buffer = buffer.subarray(newline + 1);
    try {
      const message = JSON.parse(line);
      if (!started) {
        const boot = parseBoot(message); started = true;
        deadline = setTimeout(() => controller.abort("deadline_exceeded"), 300_000);
        void runCliCheck(boot, controller.signal, emit).then(() => {
          finished = true; clearTimeout(deadline); process.stdin.destroy();
        }, () => { finished = true; clearTimeout(deadline); process.exitCode = 1; process.stdin.destroy(); });
      } else if (!finished && message && typeof message === "object" && Object.keys(message).length === 1 && message.type === "cancel") controller.abort("cancelled");
      else fail();
    } catch { fail(); }
  }
});
process.stdin.on("end", () => {
  if (started && !finished) controller.abort("cancelled");
  else if (!started) fail();
});
process.stdin.on("error", fail);
