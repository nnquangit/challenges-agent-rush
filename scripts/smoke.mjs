// End-to-end smoke test against a running ProofBox (mock mode).
//   npm run dev   (or npm run build && npm start)
//   node scripts/smoke.mjs [base-url]
// Drives the three demo presets through /api/chat → /api/runs → poll → confirm,
// plus one ad-hoc /api/sandbox/exec, and asserts the containment guarantees.
// Every API call runs in one session (POST /api/session sets the pb_session
// cookie). If the server needs an access token, set PROOFBOX_DEMO_TOKEN in the
// environment of this script too.

const BASE = process.argv[2] ?? "http://localhost:3000";
const TOKEN = process.env.PROOFBOX_DEMO_TOKEN;
let cookie = "";
async function openSession() {
  const res = await fetch(BASE + "/api/session", { method: "POST", headers: { "content-type": "application/json", ...(TOKEN ? { "x-proofbox-token": TOKEN } : {}) }, body: "{}" });
  if (!res.ok) throw new Error(`/api/session → ${res.status} ${(await res.json().catch(() => ({}))).error ?? ""} (token needed? set PROOFBOX_DEMO_TOKEN)`);
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
const headers = () => ({ "content-type": "application/json", ...(cookie ? { cookie } : {}) });
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`);
  if (!ok) failures++;
};

async function call(path, body) {
  const res = await fetch(BASE + path, body ? { method: "POST", headers: headers(), body: JSON.stringify(body) } : { headers: headers() });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data.error}`);
  return data;
}

async function waitRun(id, { approve } = {}) {
  for (let i = 0; i < 120; i++) {
    const { run } = await call(`/api/runs/${id}`);
    if (run.status === "awaiting_confirm") {
      const s = run.steps.find((x) => x.status === "awaiting_confirm");
      await call(`/api/runs/${id}/confirm`, { stepId: s.stepId, approve });
      continue;
    }
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("run timed out");
}

function allDestroyed(run) {
  return run.steps.every((s) => s.attempts.every((a) => a.isolation.destroyed && a.isolation.hostTouched === false));
}

const presets = (await import("../src/lib/presets.ts").catch(() => null))?.PRESETS;

async function runPreset(name, message, opts) {
  console.log(`\n▶ ${name}`);
  const { plan } = await call("/api/chat", { message });
  check(plan.steps.length > 0, `plan has ${plan.steps.length} steps (intent: ${plan.intent})`);
  const { run: started } = await call("/api/runs", { planId: plan.id });
  const run = await waitRun(started.id, opts);
  check(allDestroyed(run), "every sandbox destroyed, hostTouched=false");
  return { plan, run };
}

await openSession();
const status = await call("/api/status");
check(status.mode === "mock", `mode = ${status.mode} (sandbox: ${status.sandbox})`);

const msg = (id, fallback) => presets?.find((p) => p.id === id)?.message ?? fallback;

// Prove-It
{
  const { run } = await runPreset("Prove-It Python", msg("prove-it", "Run this Python:\n```python\n# proofbox:fixture=prove-primes\nN = 100\nassert total == 1060\n```"));
  const [s1, s2, s3] = run.steps;
  check(s1.status === "succeeded" && s1.attempts[0].stdout.includes("sum: 1060"), "claim proven: sum of primes < 100 = 1060");
  check(/^[0-9a-f]{64}$/.test(s1.attempts[0].sha256), "receipt has sha256");
  const probe = s2.attempts[0];
  check(!probe.stdout.includes("sk-proofbox-canary") && probe.stdout.includes("[REDACTED]"), "canary secret redacted inside sandbox");
  check(probe.isolation.blockedAttempts.length >= 3, `containment probe blocked ${probe.isolation.blockedAttempts.length} attempts`);
  check(s3.attempts[0].killedBy === "memory" && s3.attempts[0].exitCode === 137, "2 GB allocation OOM-killed at memory cap");
}

// CSV Analyst
{
  const { run } = await runPreset("CSV Analyst", msg("csv-analyst", ""));
  const s1 = run.steps[0];
  check(s1.attempts.length === 2 && s1.attempts[0].exitCode === 1 && s1.attempts[1].exitCode === 0, "first attempt KeyError, LLM repair, second attempt exit 0");
  check(s1.attempts[1].artifacts.some((a) => a.kind === "table") && s1.attempts[1].artifacts.some((a) => a.kind === "chart"), "table + chart artifacts");
  check(run.steps[1].attempts[0].isolation.blockedAttempts.some((b) => b.includes("paste.example.net")), "exfiltration POST blocked");
}

// Research with Receipts — deny the final submit
{
  const { run } = await runPreset("Research with Receipts (deny)", msg("research", ""), { approve: false });
  check(run.steps[1].verdict?.ok && run.steps[1].verdict.notes.includes("$29"), "vision verify found Pro = $29 / month");
  const meta = run.steps.find((x) => run.plan.steps.find((p) => p.id === x.stepId)?.addedBy === "policy");
  check(meta?.attempts[0].isolation.blockedAttempts.some((b) => b.includes("169.254.169.254")), "metadata endpoint blocked (policy-inserted probe)");
  const submit = run.steps.at(-1);
  check(submit.status === "skipped" && submit.attempts.length === 0, "denied submit never executed");
  check(run.events.some((e) => e.type === "confirm.requested"), "confirm was requested before final action");
}
{
  const { run } = await runPreset("Research with Receipts (approve)", msg("research", ""), { approve: true });
  const submit = run.steps.at(-1);
  check(submit.status === "succeeded" && submit.attempts[0].artifacts.some((a) => a.name === "submitted.svg"), "approved submit captured by fixture");
}

// Control-plane policy (C3): probes, confirm and egress are decided by the server
{
  console.log("\n▶ policy");
  const { plan: code } = await call("/api/chat", { message: "compute 6*7" });
  const probes = code.steps.filter((x) => x.probe);
  check(probes.length === 2 && probes.every((x) => x.addedBy === "policy"), "code plan: 2 probes inserted by policy");
  const { plan: web } = await call("/api/chat", { message: msg("research", "") });
  const submit = web.steps.find((x) => x.browser?.action === "submit");
  const probeIdx = web.steps.findIndex((x) => x.probe);
  check(submit?.requiresConfirm === true && probeIdx >= 0 && probeIdx < web.steps.indexOf(submit), "submit gated; probe runs before the gate");
  const { plan: evil } = await call("/api/chat", { message: "Open https://evil.example.org/ and https://shop.example.com/pricing" });
  check(!evil.egressAllowlist.includes("evil.example.org") && evil.egressAllowlist.includes("shop.example.com") && evil.policy.egressRefused.includes("evil.example.org"), "egress = user hosts ∩ server allowlist");
}

// Ad-hoc exec hardening (C4)
{
  console.log("\n▶ /api/sandbox/exec policy");
  const res = await fetch(BASE + "/api/sandbox/exec", { method: "POST", headers: headers(), body: JSON.stringify({ kind: "browser", url: "https://evil.example.org/", egressAllowlist: ["evil.example.org"] }) });
  check(res.status === 400, `client egressAllowlist rejected (HTTP ${res.status})`);
  const { receipt } = await call("/api/sandbox/exec", { kind: "browser", url: "https://evil.example.org/" });
  check(receipt.exitCode !== 0 && receipt.isolation.blockedAttempts.length > 0, "host outside server allowlist blocked");
}

// Ad-hoc exec
{
  console.log("\n▶ /api/sandbox/exec");
  const { receipt } = await call("/api/sandbox/exec", { kind: "code", code: "while True:\n    pass" });
  check(receipt.killedBy === "timeout" && receipt.exitCode === 124, "infinite loop killed at wall-clock cap");
  const r2 = await call("/api/sandbox/exec", { kind: "code", code: 'print("token sk-abcdefghijklmnopqrstu leaked?")\nprint(6 * 7)' });
  check(r2.receipt.stdout.includes("[REDACTED]") && r2.receipt.stdout.includes("42"), "token-shaped output scrubbed; arithmetic evaluated");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
