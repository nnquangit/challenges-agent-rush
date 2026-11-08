// Trust model (server side). One rule for every API route:
//
//   caller = the principal in a server-issued, HMAC-signed session cookie.
//
// - POST /api/session mints a principal (a random id). When PROOFBOX_DEMO_TOKEN
//   is set, minting needs that token; the token only opens the door — two people
//   with the same token still get two principals. The MAC also covers a hash of
//   the token, so rotating the token ends every session.
// - Plans and runs carry `owner` = principal. List, read, dispatch and confirm
//   only ever see the caller's own objects; anything else is 404 (no oracle).
// - Rate limits and sandbox fairness are keyed by principal; client IPs are
//   used only when a proxy is explicitly trusted (src/lib/rate-limit.ts).
// - Local mode answers only loopback Host headers; public mode refuses to run
//   without the token and a stable signing key (src/lib/config.ts).
// - The cookie is HttpOnly + SameSite=Strict (+ Secure in public mode), and a
//   cross-origin Origin header is refused, so another site cannot ride it.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { configProblems, demoToken, exposure, MIN_SESSION_SECRET_LENGTH, sessionQuotas } from "./config";
import { bad, json } from "./http";

export const SESSION_COOKIE = "pb_session";
const VERSION = "pb1";

const g = globalThis as unknown as { __proofboxSessionSecret?: Buffer };

function secret(): Buffer {
  const env = process.env.PROOFBOX_SESSION_SECRET;
  if (env && env.length >= MIN_SESSION_SECRET_LENGTH) return Buffer.from(env, "utf8");
  // Ephemeral per process: sessions end on restart, like the in-memory runs they own.
  return (g.__proofboxSessionSecret ??= randomBytes(32));
}

function mac(principal: string, issuedAt: number): string {
  const tokenHash = createHash("sha256").update(demoToken() ?? "").digest("hex");
  return createHmac("sha256", secret()).update(`${VERSION}|${principal}|${issuedAt}|${tokenHash}`).digest("base64url");
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface Session {
  principal: string;
  issuedAt: number;
  expiresAt: number;
}

export function signSession(principal: string, issuedAt = Date.now()): string {
  return `${VERSION}.${principal}.${issuedAt.toString(36)}.${mac(principal, issuedAt)}`;
}

/** Parse and check a session cookie value. Null when missing, forged, stale or expired. */
export function verifySession(value: string | undefined | null, at = Date.now()): Session | null {
  if (!value || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !/^pr_[0-9a-f]{32}$/.test(parts[1])) return null;
  const issuedAt = Number.parseInt(parts[2], 36);
  if (!Number.isFinite(issuedAt)) return null;
  if (!safeEqual(parts[3], mac(parts[1], issuedAt))) return null;
  const expiresAt = issuedAt + sessionQuotas().ttlMs;
  if (at >= expiresAt || issuedAt > at + 60_000) return null;
  return { principal: parts[1], issuedAt, expiresAt };
}

export const newPrincipal = () => `pr_${randomBytes(16).toString("hex")}`;

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const sessionFrom = (req: Request) => verifySession(cookieValue(req, SESSION_COOKIE));

/** Short, non-secret label for the UI ("pr_1a2b3c4d…"). */
export const principalLabel = (p: string) => `${p.slice(0, 11)}…`;

export function tokenMatches(req: Request): boolean {
  const want = demoToken();
  if (!want) return true;
  return safeEqual(req.headers.get("x-proofbox-token") ?? "", want);
}

function hostOf(req: Request): string {
  const h = (req.headers.get("host") ?? "").toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]";
}

/**
 * Checks shared by every API route, before any work: config sane (503),
 * Host allowed for the exposure mode (403), Origin same-site (403).
 */
export function precheck(req: Request): Response | null {
  const problems = configProblems();
  if (problems.length) return json({ error: "server misconfigured — see server log", code: "config_error", problems }, 503);
  if (exposure() === "local" && !isLoopbackHost(hostOf(req)))
    return json({ error: "local mode only answers loopback hosts; set PROOFBOX_PUBLIC=1 (with PROOFBOX_DEMO_TOKEN and RECEIPT_SIGNING_KEY) to expose it", code: "host_not_allowed" }, 403);
  const origin = req.headers.get("origin");
  if (origin && req.method !== "GET") {
    let same = false;
    try {
      same = new URL(origin).host.toLowerCase() === (req.headers.get("host") ?? "").toLowerCase();
    } catch {
      /* malformed origin */
    }
    if (!same) return json({ error: "cross-origin request refused", code: "bad_origin" }, 403);
  }
  return null;
}

/** precheck + a valid session. Returns the caller's principal, or the error response. */
export function requireSession(req: Request): { principal: string } | Response {
  const fail = precheck(req);
  if (fail) return fail;
  const s = sessionFrom(req);
  if (!s) return json({ error: "no valid session — POST /api/session first", code: "session_required" }, 401);
  return { principal: s.principal };
}

export function setSessionCookie(res: NextResponse, value: string) {
  res.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: exposure() === "public",
    path: "/",
    maxAge: Math.floor(sessionQuotas().ttlMs / 1000),
  });
  return res;
}

export const forbidden = (message: string) => bad(message, 403);
