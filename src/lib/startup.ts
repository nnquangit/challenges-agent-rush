// Startup checks: a misconfigured server must not start (src/instrumentation.ts).
import { configProblems, demoToken, exposure, trustProxyHops } from "./config";
import { initSigningKey, SigningKeyError } from "./sandbox/signing";

export function startupProblems(): string[] {
  const problems = configProblems();
  try {
    initSigningKey();
  } catch (e) {
    problems.push(e instanceof SigningKeyError ? e.message : "RECEIPT_SIGNING_KEY could not be loaded");
  }
  return problems;
}

/** One line for the server log; names only, never values. */
export function startupSummary(): string {
  const k = initSigningKey();
  return `[proofbox] exposure=${exposure()} token=${demoToken() ? "set" : "unset"} trustProxyHops=${trustProxyHops()} receiptKey=${k.keyId}${k.ephemeral ? " (ephemeral: receipts stop verifying after a restart)" : ""}`;
}

/** Log and exit(1) on any startup problem; otherwise log the one-line summary. */
export function enforceStartup() {
  const problems = startupProblems();
  if (problems.length) {
    console.error(`[proofbox] refusing to start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(startupSummary());
}
