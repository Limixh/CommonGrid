import type { IncomingMessage, ServerResponse } from "node:http";
// Relative source imports let Vite bundle its Node config on the supported Node 22 runtime.
// The browser component uses the separate pure ./recovery package export.
import { projectOperationRecovery, recoveryOperationLimit } from "../../packages/agent-adapters/src/operation-recovery.ts";
import { readOperationJournals } from "../../packages/agent-adapters/src/operation-journal.ts";
import type { OperationJournalReadResult } from "../../packages/agent-adapters/src/operation-journal-types.ts";

type Reader = (root: string, options: {maxOperations: number}) => Promise<OperationJournalReadResult>;
/** Fixed local source; requests cannot choose a path or mutate a journal. */
export function operationStatusMiddleware(root: string, reader: Reader = readOperationJournals) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (status: number, code: string) => { res.statusCode = status; res.end(JSON.stringify({code})); };
    if (!["127.0.0.1:1420", "localhost:1420"].includes(req.headers.host ?? "")) return fail(403, "invalid_host");
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${req.headers.host}`) return fail(403, "invalid_origin");
    if (req.headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) return fail(403, "invalid_origin");
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return fail(405, "method_not_allowed"); }
    if (req.url !== "/" && req.url !== "") return fail(400, "invalid_request");
    try { res.end(JSON.stringify(projectOperationRecovery(await reader(root, {maxOperations: recoveryOperationLimit})))); }
    catch { res.statusCode = 503; res.end(JSON.stringify(projectOperationRecovery({status: "blocked", reason: "operation_journal_io_failed", operations: []}))); }
  };
}
