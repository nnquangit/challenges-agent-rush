// Fixed-window rate limit per key. Keys are session principals (src/lib/access.ts)
// and, only when a reverse proxy is explicitly trusted, client IPs.
// In memory, one process: enough for one VM (bounded to MAX_KEYS keys).
import { isIP } from "node:net";
import { trustProxyHops } from "./config";

const windows = new Map<string, { start: number; count: number }>();
const WINDOW_MS = 60_000;
const MAX_KEYS = 5000;

/** Returns seconds to wait, or 0 if the call is allowed (and counted). */
export function rateLimit(key: string, perMinute: number, at = Date.now()): number {
  const w = windows.get(key);
  if (!w || at - w.start >= WINDOW_MS) {
    windows.delete(key);
    windows.set(key, { start: at, count: 1 });
    // Evict the oldest window first; expired ones go before live ones.
    if (windows.size > MAX_KEYS) {
      for (const [k, v] of windows) if (at - v.start >= WINDOW_MS) windows.delete(k);
      while (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value as string);
    }
    return 0;
  }
  if (w.count >= perMinute) return Math.ceil((w.start + WINDOW_MS - at) / 1000);
  w.count++;
  return 0;
}

/**
 * Client IP, or null when it cannot be known safely.
 * App Router handlers do not see the socket address, so the only source is
 * X-Forwarded-For — which any client can write. It is read only when
 * PROOFBOX_TRUST_PROXY=<hops> says how many proxies append to it; the client is
 * then the entry `hops` places from the RIGHT (the left-most value is whatever
 * the client sent). Without that setting: null, and callers fall back to the
 * session principal plus global limits. X-Real-IP is never trusted.
 */
export function clientIp(req: Request): string | null {
  const hops = trustProxyHops();
  if (!hops) return null;
  const parts = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = parts[parts.length - hops];
  return ip && isIP(ip) ? ip : null;
}
