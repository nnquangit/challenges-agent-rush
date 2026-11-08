// Runs once when the Next.js server starts. A server with bad security config
// refuses to start (exit 1) instead of failing later or running unprotected:
// PROOFBOX_PUBLIC=1 without PROOFBOX_DEMO_TOKEN / RECEIPT_SIGNING_KEY, a
// malformed RECEIPT_SIGNING_KEY, a too-short token, a bad PROOFBOX_TRUST_PROXY.
// API routes repeat the config check per request (503) as a second line.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { enforceStartup } = await import("./lib/startup");
  enforceStartup();
}
