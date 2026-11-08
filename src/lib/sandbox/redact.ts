// Secret hygiene: secrets never enter a sandbox, and never leave one in output.

export const SECRET_KEY = /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i;
export const REDACTED = "[REDACTED]";

// Token shapes worth scrubbing even if they did not come from our env.
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];

/** Only these non-secret host variables are forwarded into a sandbox. */
const FORWARD_ALLOWLIST = ["LANG", "TZ"];

/** Only app-scoped secret names are shown (redacted); other host names would leak host info. */
const SCOPED_SECRET = /^(VULTR_|PROOFBOX_)/;

/**
 * Build the env a sandbox sees. App-scoped secret keys from the host are kept
 * as names (so the demo shows they exist) but their values are replaced.
 * Everything else from the host — including its other secrets — is dropped,
 * except a tiny non-secret allowlist.
 */
export function buildSandboxEnv(
  hostEnv: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): { env: Record<string, string>; redactions: number } {
  const env: Record<string, string> = { HOME: "/sandbox", USER: "sandbox", PATH: "/usr/local/bin:/usr/bin:/bin" };
  let redactions = 0;
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined) continue;
    if (SECRET_KEY.test(k)) {
      if (!SCOPED_SECRET.test(k)) continue;
      env[k] = REDACTED;
      redactions++;
    } else if (FORWARD_ALLOWLIST.includes(k)) {
      env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (SECRET_KEY.test(k)) {
      env[k] = REDACTED;
      redactions++;
    } else env[k] = v;
  }
  return { env, redactions };
}

/** Scrub any host secret value or token-shaped string out of sandbox output. */
export function redactText(
  text: string,
  hostEnv: Record<string, string | undefined> = process.env,
): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const [k, v] of Object.entries(hostEnv)) {
    if (!v || v.length < 6 || !SECRET_KEY.test(k)) continue;
    const parts = out.split(v);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(REDACTED);
    }
  }
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  }
  return { text: out, count };
}
