import type { ResourceLimits } from "./types";

/**
 * Mock is the default. Only an explicit MOCK=0 switches to Vultr providers,
 * so a missing or broken env never leads to accidental network calls.
 */
export function isMock(): boolean {
  return process.env.MOCK !== "0";
}

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultLimits(): ResourceLimits {
  return {
    timeoutMs: intEnv("SANDBOX_TIMEOUT_MS", 5000),
    memoryMb: intEnv("SANDBOX_MEMORY_MB", 256),
  };
}

/** Hard ceilings — a plan can ask for less, never more. */
export const MAX_LIMITS: ResourceLimits = { timeoutMs: 30_000, memoryMb: 1024 };

export function resolveLimits(requested?: Partial<ResourceLimits>): ResourceLimits {
  const d = defaultLimits();
  return {
    timeoutMs: Math.min(requested?.timeoutMs ?? d.timeoutMs, MAX_LIMITS.timeoutMs),
    memoryMb: Math.min(requested?.memoryMb ?? d.memoryMb, MAX_LIMITS.memoryMb),
  };
}

export function vultrInferenceConfig() {
  return {
    baseUrl: process.env.VULTR_INFERENCE_BASE_URL || "https://api.vultrinference.com/v1",
    model: process.env.VULTR_INFERENCE_MODEL || "",
    apiKeyPresent: Boolean(process.env.VULTR_INFERENCE_API_KEY),
  };
}

/** Fixture hosts MockSandbox can serve. Default server egress allowlist. */
export const DEFAULT_EGRESS_ALLOWLIST = ["shop.example.com", "example.com", "docs.example.com"];

/**
 * Server-side egress allowlist (SANDBOX_EGRESS_ALLOWLIST, comma-separated).
 * Neither the planner nor an API client can widen it.
 */
export function egressAllowlist(): string[] {
  const raw = process.env.SANDBOX_EGRESS_ALLOWLIST;
  const list = raw === undefined ? DEFAULT_EGRESS_ALLOWLIST : raw.split(",");
  return [...new Set(list.map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Abuse limits. Everything that can be queued or retried is bounded, and every
 * per-caller limit is keyed by the session principal (src/lib/access.ts), not
 * by a client-supplied header. In memory, one process (see docs: L6).
 */
export function sandboxQuotas() {
  const maxConcurrent = intEnv("SANDBOX_MAX_CONCURRENT", 3);
  return {
    /** Sandboxes alive at the same time, across all principals. */
    maxConcurrent,
    /** Sandboxes one principal may hold at once (never more than maxConcurrent). */
    slotsPerPrincipal: Math.min(intEnv("SANDBOX_SLOTS_PER_PRINCIPAL", 2), maxConcurrent),
    /** Callers waiting for a slot, across all principals. Beyond this: 429. */
    maxQueued: intEnv("SANDBOX_MAX_QUEUED", 12),
    /** Callers one principal may have waiting. Beyond this: 429. */
    queuePerPrincipal: intEnv("SANDBOX_QUEUE_PER_PRINCIPAL", 4),
    /** How long an ad-hoc exec waits (fairly, round-robin by principal) for a slot before 429. */
    execWaitMs: intEnv("SANDBOX_EXEC_WAIT_MS", 5000),
    /** How long a run step waits for a slot before the run fails. */
    runWaitMs: intEnv("SANDBOX_RUN_WAIT_MS", 120_000),
    /** Ad-hoc /api/sandbox/exec calls per principal (and per client IP when a proxy is trusted) per minute. */
    execPerMinute: intEnv("SANDBOX_EXEC_PER_MINUTE", 20),
  };
}

/** Limits for planning and dispatching runs (per principal unless stated). */
export function runQuotas() {
  return {
    chatPerMinute: intEnv("CHAT_PER_MINUTE", 20),
    runsPerMinute: intEnv("RUNS_PER_MINUTE", 10),
    /** Runs that are running or waiting for a human, per principal. */
    activePerPrincipal: intEnv("RUNS_ACTIVE_PER_PRINCIPAL", 2),
    /** Runs that are running, across all principals. */
    activeMax: intEnv("RUNS_ACTIVE_MAX", 8),
    /** An unanswered human gate is denied after this long. */
    confirmTtlMs: intEnv("CONFIRM_TTL_MS", 10 * 60_000),
  };
}

/** Session limits: minting is global (+ per IP when a proxy is trusted). */
export function sessionQuotas() {
  return {
    mintPerMinute: intEnv("SESSIONS_PER_MINUTE", 60),
    mintPerIpPerMinute: intEnv("SESSIONS_PER_IP_PER_MINUTE", 10),
    ttlMs: intEnv("SESSION_TTL_MS", 12 * 60 * 60_000),
  };
}

/**
 * Access token (header x-proofbox-token). When set, it is required to START a
 * session (POST /api/session); it is never an identity — every session gets
 * its own principal. Unset = open local demo. Required when PROOFBOX_PUBLIC=1.
 */
export function demoToken(): string | null {
  return process.env.PROOFBOX_DEMO_TOKEN || null;
}

/**
 * Exposure. "local" (default): the API answers only requests whose Host is
 * loopback (localhost, 127.0.0.0/8, [::1]) — guards against accidental
 * exposure through a proxy and DNS rebinding of the local app.
 * "public" (PROOFBOX_PUBLIC=1): any Host, but the server refuses to start
 * (and refuses requests) unless the access token and a stable signing key are set.
 */
export function exposure(): "local" | "public" {
  return process.env.PROOFBOX_PUBLIC === "1" ? "public" : "local";
}

/**
 * Number of reverse proxies in front of the app whose X-Forwarded-For entries
 * are trusted (PROOFBOX_TRUST_PROXY, 0-5). 0 / unset = never read proxy headers.
 */
export function trustProxyHops(): number {
  const raw = process.env.PROOFBOX_TRUST_PROXY;
  if (!raw || raw === "0") return 0;
  return /^[1-5]$/.test(raw) ? Number(raw) : 0;
}

export const MIN_TOKEN_LENGTH = 16;
export const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Config errors that must stop the server (checked at startup by
 * src/instrumentation.ts and again on every API request). Never includes values.
 */
export function configProblems(): string[] {
  const p: string[] = [];
  const pub = process.env.PROOFBOX_PUBLIC;
  if (pub !== undefined && pub !== "" && pub !== "0" && pub !== "1") p.push('PROOFBOX_PUBLIC must be "1" (public) or "0"/unset (local)');
  const tp = process.env.PROOFBOX_TRUST_PROXY;
  if (tp && tp !== "0" && !/^[1-5]$/.test(tp)) p.push("PROOFBOX_TRUST_PROXY must be a hop count 0-5");
  const token = demoToken();
  if (token && token.length < MIN_TOKEN_LENGTH) p.push(`PROOFBOX_DEMO_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  const secret = process.env.PROOFBOX_SESSION_SECRET;
  if (secret && secret.length < MIN_SESSION_SECRET_LENGTH) p.push(`PROOFBOX_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`);
  if (exposure() === "public") {
    if (!token) p.push("PROOFBOX_PUBLIC=1 requires PROOFBOX_DEMO_TOKEN");
    if (!process.env.RECEIPT_SIGNING_KEY) p.push("PROOFBOX_PUBLIC=1 requires RECEIPT_SIGNING_KEY (a stable Ed25519 key)");
  }
  return p;
}
