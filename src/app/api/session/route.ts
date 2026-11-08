import { NextResponse } from "next/server";
import { newPrincipal, precheck, principalLabel, sessionFrom, setSessionCookie, signSession, tokenMatches } from "@/lib/access";
import { demoToken, exposure, sessionQuotas } from "@/lib/config";
import { bad, json } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const describe = (principal: string, expiresAt: number) => ({
  principal: principalLabel(principal),
  expiresAt: new Date(expiresAt).toISOString(),
  exposure: exposure(),
  tokenRequired: Boolean(demoToken()),
});

/** GET /api/session → the current session, or 401. */
export function GET(req: Request) {
  const fail = precheck(req);
  if (fail) return fail;
  const s = sessionFrom(req);
  return s ? json({ session: describe(s.principal, s.expiresAt) }) : json({ error: "no session", code: "session_required", tokenRequired: Boolean(demoToken()) }, 401);
}

/**
 * POST /api/session → sets the HttpOnly session cookie (a new principal) and
 * returns its public label. A still-valid session is returned as is.
 * Needs header x-proofbox-token when PROOFBOX_DEMO_TOKEN is set.
 * Minting is rate-limited globally, and per client IP when a proxy is trusted.
 */
export function POST(req: Request) {
  const fail = precheck(req);
  if (fail) return fail;
  if (!tokenMatches(req)) return json({ error: "missing or wrong x-proofbox-token", code: "token_required", tokenRequired: true }, 401);
  const current = sessionFrom(req);
  if (current) return json({ session: describe(current.principal, current.expiresAt) });
  const q = sessionQuotas();
  const ip = clientIp(req);
  const wait = (ip && rateLimit(`session:ip:${ip}`, q.mintPerIpPerMinute)) || rateLimit("session:all", q.mintPerMinute);
  if (wait) return bad(`too many new sessions — retry in ${wait}s`, 429);
  const principal = newPrincipal();
  const issuedAt = Date.now();
  const res = NextResponse.json({ session: describe(principal, issuedAt + q.ttlMs) }, { headers: { "cache-control": "no-store" } });
  return setSessionCookie(res, signSession(principal, issuedAt));
}
