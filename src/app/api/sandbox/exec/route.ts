import { bad, json, readJson } from "@/lib/http";
import { newId } from "@/lib/ids";
import { requireSession } from "@/lib/access";
import { egressAllowlist, sandboxQuotas } from "@/lib/config";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { runInSandbox, SandboxBusy, type ExecRequest } from "@/lib/sandbox";
import type { BrowserAction } from "@/lib/types";

export const dynamic = "force-dynamic";
const MAX_CODE = 20_000;
const ACTIONS: BrowserAction[] = ["navigate", "screenshot", "fill"]; // "submit" only via a confirmed run

interface Body {
  kind?: unknown;
  code?: unknown;
  url?: unknown;
  action?: unknown;
  expect?: unknown;
  files?: unknown;
  egressAllowlist?: unknown;
}

/**
 * POST /api/sandbox/exec — one-off exec in a fresh sandbox, returns the receipt.
 *   { kind: "code", code, files? }
 *   { kind: "browser", url, action?, expect? }
 * Egress is the server allowlist (SANDBOX_EGRESS_ALLOWLIST) — clients cannot widen it.
 * Guards: session (src/lib/access.ts; the access token gates the session), rate
 * limit per principal (and per client IP when PROOFBOX_TRUST_PROXY is set), and a
 * fair, bounded wait for one of the global sandbox slots (429 when none frees up).
 */
export async function POST(req: Request) {
  const who = requireSession(req);
  if (who instanceof Response) return who;
  const q = sandboxQuotas();
  const ip = clientIp(req);
  const wait = rateLimit(`exec:${who.principal}`, q.execPerMinute) || (ip ? rateLimit(`exec:ip:${ip}`, q.execPerMinute) : 0);
  if (wait) return json({ error: `rate limited — retry in ${wait}s` }, 429);
  const b = await readJson<Body>(req);
  if (!b) return bad("JSON body required");
  if (b.egressAllowlist !== undefined) return bad("egressAllowlist is set by the server, not the client");
  let request: ExecRequest;
  let egress: string[] = [];
  if (b.kind === "code") {
    if (typeof b.code !== "string" || !b.code.trim()) return bad("code is required");
    if (b.code.length > MAX_CODE) return bad(`code exceeds ${MAX_CODE} characters`, 413);
    request = { kind: "code", language: "python", code: b.code };
  } else if (b.kind === "browser") {
    if (typeof b.url !== "string") return bad("url is required");
    const action = (typeof b.action === "string" ? b.action : "navigate") as BrowserAction;
    if (!ACTIONS.includes(action)) return bad(`action must be one of ${ACTIONS.join(", ")}`);
    request = { kind: "browser", browser: { action, url: b.url, expect: typeof b.expect === "string" ? b.expect : undefined } };
    egress = egressAllowlist();
  } else return bad('kind must be "code" or "browser"');

  const files =
    b.files && typeof b.files === "object"
      ? Object.fromEntries(Object.entries(b.files as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][])
      : undefined;
  if (files && Object.values(files).reduce((n, v) => n + v.length, 0) > 200_000) return bad("files exceed 200000 characters", 413);
  try {
    const receipt = await runInSandbox({ taskId: newId("adhoc"), stepId: "adhoc", attempt: 1, request, files, egressAllowlist: egress, principal: who.principal, maxWaitMs: q.execWaitMs });
    return json({ receipt });
  } catch (e) {
    if (e instanceof SandboxBusy) return json({ error: e.message }, 429);
    throw e;
  }
}
