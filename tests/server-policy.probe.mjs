// Black-box checks against a running ProofBox (mock) — receipts + server policy.
//   node --import tsx tests/server-policy.probe.mjs http://127.0.0.1:3117
// Not part of `npm test` (needs a server). Prints one line per check; exit 1 on any FAIL.
// Every call runs in a session (tests/lib/pb-client.mjs; PROOFBOX_DEMO_TOKEN is
// used when the server needs it). Limits are per session principal, so sections
// that need fresh limits use a fresh client. 2026-11-07 (security fixes): the
// x-forwarded-for buckets of the old version no longer exist; the XFF bypass
// check below is kept unchanged in intent.

import { createHash, createPublicKey, verify } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { receiptPayload } from "../src/lib/receipt-canonical.ts";
import { anon, makeClient } from "./lib/pb-client.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:3117";
const OUT = process.env.PB_OUT ?? "/tmp/pb-test";
mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};
const fresh = (opts) => makeClient(BASE, opts);
const main = fresh();
const post = (path, body, who = main, headers = {}) => who.post(path, body, headers);
const get = async (path, who = main) => (await who.get(path)).data;
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- 2. receipts ----------
console.log("\n# receipts");
const pk = await get("/api/receipts/public-key");
const key = createPublicKey({ key: Buffer.from(pk.spki, "base64"), format: "der", type: "spki" });
const verifyR = (r) => {
  const p = Buffer.from(receiptPayload(r), "utf8");
  const hashOk = createHash("sha256").update(p).digest("hex") === r.sha256;
  let sigOk = false;
  try { sigOk = verify(null, p, key, Buffer.from(r.signature?.value ?? "", "base64")); } catch {}
  return { hashOk, sigOk, ok: hashOk && sigOk };
};

const okRun = await post("/api/sandbox/exec", { kind: "code", code: 'print("hello receipt")' });
const loopRun = await post("/api/sandbox/exec", { kind: "code", code: "while True:\n    pass" });
const r = okRun.data.receipt;
const rl = loopRun.data.receipt;
writeFileSync(`${OUT}/receipt-ok.json`, JSON.stringify(r, null, 2));
check(okRun.status === 200 && verifyR(r).ok, "fresh receipt verifies (sha256 + Ed25519)", `keyId ${pk.keyId} ephemeral=${pk.ephemeral}`);
check(rl && rl.killedBy === "timeout" && verifyR(rl).ok, "timeout receipt verifies", `killedBy=${rl?.killedBy} exit=${rl?.exitCode}`);

const tampers = [
  ["isolation.hostTouched=true", (x) => (x.isolation.hostTouched = true)],
  ["isolation.destroyed=false", (x) => (x.isolation.destroyed = false)],
  ["isolation.simulated=false", (x) => (x.isolation.simulated = false)],
  ["isolation.networkPolicy edited", (x) => (x.isolation.networkPolicy = "egress: any")],
  ["isolation.blockedAttempts += item", (x) => x.isolation.blockedAttempts.push("network evil")],
  ["limits.memoryMb=4096", (x) => (x.limits.memoryMb = 4096)],
  ["limits.timeoutMs=1", (x) => (x.limits.timeoutMs = 1)],
  ["stdout edited", (x) => (x.stdout = x.stdout.replace("hello", "HELLO"))],
  ["stdout appended whitespace", (x) => (x.stdout += " ")],
  ["exitCode 0→1", (x) => (x.exitCode = 1)],
  ["killedBy added (memory)", (x) => (x.killedBy = "memory")],
  ["killedBy=null", (x) => (x.killedBy = null)],
  ["clock=wall", (x) => (x.clock = "wall")],
  ["extra top-level field", (x) => (x.note = "trust me")],
  ["sha256 recomputed by attacker", (x) => { x.stdout = "forged"; x.sha256 = createHash("sha256").update(receiptPayload(x)).digest("hex"); }],
];
for (const [name, fn] of tampers) {
  const t = clone(r);
  fn(t);
  const v = verifyR(t);
  check(!v.ok, `tamper ${name} → verify fails`, `hash=${v.hashOk} sig=${v.sigOk}`);
}
for (const [name, fn] of [
  ["killedBy timeout→memory", (x) => (x.killedBy = "memory")],
  ["killedBy removed", (x) => delete x.killedBy],
  ["stdout of timeout run edited", (x) => (x.stdout = "done")],
]) {
  const t = clone(rl);
  fn(t);
  const v = verifyR(t);
  check(!v.ok, `tamper ${name} → verify fails`, `hash=${v.hashOk} sig=${v.sigOk}`);
}
{ // key reorder must NOT break (canonical JSON)
  const t = Object.fromEntries(Object.entries(clone(r)).reverse());
  check(verifyR(t).ok, "same receipt, keys reordered → still verifies (canonical)");
}
{ const t = clone(r); t.isolation.hostTouched = true; writeFileSync(`${OUT}/receipt-tampered.json`, JSON.stringify(t, null, 2)); }

// ---------- 3. server policy ----------
console.log("\n# policy: plans + runs");
const chat = async (message) => (await post("/api/chat", { message })).data;
{
  const { plan } = await chat("Run this Python:\n```python\nprint(2+2)\n```");
  const probes = plan.steps.filter((s) => s.probe);
  check(probes.length === 2 && probes.every((s) => s.addedBy === "policy"), "code plan: 2 probes, addedBy=policy", probes.map((s) => s.title).join(", "));
}
{
  const { plan } = await chat("Open https://shop.example.com/pricing and http://169.254.169.254/ and http://localhost:3000 and https://evil.example.net, then submit the form");
  const sub = plan.steps.find((s) => s.browser?.action === "submit");
  check(JSON.stringify(plan.egressAllowlist) === '["shop.example.com"]', "egress = user hosts ∩ server allowlist", `allow=${JSON.stringify(plan.egressAllowlist)} refused=${JSON.stringify(plan.policy?.egressRefused)}`);
  if (sub) {
    const gate = plan.steps.indexOf(sub);
    const probeIdx = plan.steps.findIndex((s) => s.probe);
    check(sub.requiresConfirm === true && probeIdx > -1 && probeIdx < gate, "submit requiresConfirm, probe before gate");
  } else check(true, "no submit step in this plan (gate tested via research preset below)");
}
{
  const res = await post("/api/runs", { planId: "plan_nope", steps: [{ kind: "code", code: "print(1)" }] });
  check(res.status === 404, "POST /api/runs with client-made steps → 404", `HTTP ${res.status}`);
  const big = await post("/api/chat", { message: "x".repeat(20_001) });
  check(big.status === 413, "chat message > 20000 chars → 413", `HTTP ${big.status}`);
  const badJson = await post("/api/chat", "{not json");
  check(badJson.status === 400, "chat invalid JSON → 400", `HTTP ${badJson.status}`);
}

console.log("\n# policy: confirm gate");
const research = "Open https://shop.example.com/pricing, capture evidence of the Pro plan price, and fill the contact form as a draft. Don't submit without my confirmation.";
async function runUntilGate() {
  const { plan } = await chat(research);
  const { data } = await post("/api/runs", { planId: plan.id });
  for (let i = 0; i < 100; i++) {
    const { run } = await get(`/api/runs/${data.run.id}`);
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("run did not reach gate");
}
async function waitDone(id) {
  for (let i = 0; i < 100; i++) {
    const { run } = await get(`/api/runs/${id}`);
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timeout");
}
{
  const run = await runUntilGate();
  const gated = run.steps.find((s) => s.status === "awaiting_confirm");
  check(run.status === "awaiting_confirm" && gated, "run pauses at awaiting_confirm", `step ${gated?.stepId}`);
  const notGated = run.steps.find((s) => s.stepId !== gated.stepId);
  const wrongStep = await post(`/api/runs/${run.id}/confirm`, { stepId: notGated.stepId, approve: true });
  check(wrongStep.status === 409, "confirm a step that is not waiting → 409", `HTTP ${wrongStep.status}`);
  const strApprove = await post(`/api/runs/${run.id}/confirm`, { stepId: gated.stepId, approve: "yes" });
  check(strApprove.status === 400, 'approve:"yes" (not boolean) → 400', `HTTP ${strApprove.status}`);
  const deny = await post(`/api/runs/${run.id}/confirm`, { stepId: gated.stepId, approve: false });
  check(deny.status === 200, "deny accepted", `HTTP ${deny.status}`);
  const flip = await post(`/api/runs/${run.id}/confirm`, { stepId: gated.stepId, approve: true });
  check(flip.status === 409, "approve after deny → 409 (no flip)", `HTTP ${flip.status}`);
  const done = await waitDone(run.id);
  const s = done.steps.find((x) => x.stepId === gated.stepId);
  check(s.status === "skipped" && s.attempts.length === 0, "denied submit: skipped, 0 sandbox attempts");
}
{
  const run = await runUntilGate();
  const gated = run.steps.find((s) => s.status === "awaiting_confirm");
  const [a, b] = await Promise.all([
    post(`/api/runs/${run.id}/confirm`, { stepId: gated.stepId, approve: true }),
    post(`/api/runs/${run.id}/confirm`, { stepId: gated.stepId, approve: true }),
  ]);
  check([a.status, b.status].sort().join() === "200,409", "two concurrent approves → one 200, one 409", `${a.status},${b.status}`);
  const done = await waitDone(run.id);
  const s = done.steps.find((x) => x.stepId === gated.stepId);
  check(s.status === "succeeded" && s.attempts.length === 1, "approved submit ran exactly once", `status=${s.status} attempts=${s.attempts.length}`);
  check(!JSON.stringify(done).includes("sk-proofbox-canary"), "canary value absent from full run JSON");
}

console.log("\n# /api/sandbox/exec: egress");
{
  const ip = main;
  for (const body of [
    { kind: "browser", url: "https://example.com", egressAllowlist: ["evil.com"] },
    { kind: "browser", url: "https://example.com", egressAllowlist: [] },
    { kind: "browser", url: "https://example.com", egressAllowlist: null },
    { kind: "code", code: "print(1)", egressAllowlist: ["*"] },
  ]) {
    const res = await post("/api/sandbox/exec", body, ip);
    check(res.status === 400, `client egressAllowlist=${JSON.stringify(body.egressAllowlist)} (${body.kind}) → 400`, `HTTP ${res.status}`);
  }
  const sub = await post("/api/sandbox/exec", { kind: "browser", url: "https://shop.example.com/contact", action: "submit" }, ip);
  check(sub.status === 400, "ad-hoc browser submit → 400", `HTTP ${sub.status}`);
}
const targets = [
  "http://169.254.169.254/latest/meta-data/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://[fd00:ec2::254]/latest/meta-data/",
  "http://169.254.170.2/v2/credentials",
  "http://example.com@169.254.169.254/",
  "http://2852039166/", // 169.254.169.254 decimal
  "http://0xA9FEA9FE/",
  "http://localhost:3000/",
  "http://127.0.0.1:3117/api/status",
  "http://127.1/",
  "http://0.0.0.0:4000/",
  "http://[::1]/",
  "http://[0:0:0:0:0:0:0:1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::127.0.0.1]/",
  "http://sub.localhost/",
  "http://10.0.0.1/",
  "http://172.16.5.4/",
  "http://192.168.1.1/",
  "http://100.64.0.1/",
  "http://[fc00::1]/",
  "http://[fe80::1]/",
  "http://198.18.0.1/",
  "http://224.0.0.1/",
  "http://evil.example.net/",
  "http://example.com.evil.net/",
  "http://EXAMPLE.COM./",
  "file:///etc/passwd",
  "gopher://example.com/",
];
let targetClient = fresh();
for (const [i, url] of targets.entries()) {
  if (i && i % 10 === 0) targetClient = fresh(); // stay under the per-principal exec limit
  const res = await post("/api/sandbox/exec", { kind: "browser", url }, targetClient);
  const rc = res.data?.receipt;
  const blocked = rc ? rc.isolation.blockedAttempts.length > 0 && rc.exitCode !== 0 : res.status >= 400;
  const reason = rc ? (rc.stderr.match(/—\s*(.*)$/m)?.[1] ?? rc.stderr.slice(0, 80)) : res.data?.error;
  check(blocked, `browser → ${url} blocked`, `HTTP ${res.status} ${reason}`);
}
{
  const who = fresh();
  const res = await post("/api/sandbox/exec", { kind: "browser", url: "https://example.com/", action: "screenshot" }, who);
  check(res.data?.receipt?.exitCode === 0, "allowlisted https://example.com/ → served by fixture (exit 0)");
  const res2 = await post("/api/sandbox/exec", { kind: "code", code: 'import requests\nrequests.get("http://169.254.169.254/latest/meta-data/")' }, who);
  check(res2.data?.receipt?.isolation.blockedAttempts.some((b) => b.includes("169.254")), "code → metadata blocked (deny-all egress)");
}

console.log("\n# /api/sandbox/exec: input limits");
{
  const ip = fresh();
  const big = await post("/api/sandbox/exec", { kind: "code", code: "#".repeat(20_001) }, ip);
  check(big.status === 413, "code > 20000 chars → 413", `HTTP ${big.status}`);
  const files = await post("/api/sandbox/exec", { kind: "code", code: "print(1)", files: { a: "x".repeat(200_001) } }, ip);
  check(files.status === 413, "files > 200000 chars → 413", `HTTP ${files.status}`);
  const kind = await post("/api/sandbox/exec", { kind: "shell", code: "id" }, ip);
  check(kind.status === 400, "kind=shell → 400", `HTTP ${kind.status}`);
}

console.log("\n# rate limit");
{
  const ip = fresh();
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await post("/api/sandbox/exec", { kind: "code", code: "print(1)" }, ip)).status);
  const ok = codes.filter((c) => c === 200).length;
  const lim = codes.filter((c) => c === 429).length;
  check(ok === 20 && lim === 2, "same client: 22 calls → 20×200, 2×429", `${ok}×200 ${lim}×429`);
  // Spoofed x-forwarded-for: a new value per request must not get a new bucket.
  const spoofer = fresh();
  const spoof = [];
  for (let i = 0; i < 25; i++) spoof.push((await post("/api/sandbox/exec", { kind: "code", code: "print(1)" }, spoofer, { "x-forwarded-for": `203.0.113.${i}` })).status);
  const sOk = spoof.filter((c) => c === 200).length;
  check(sOk < 25, "rotating x-forwarded-for cannot bypass the limit", `${sOk}/25 × 200 with rotating XFF from one client`);
}

console.log("\n# concurrency");
{
  // 2026-11-07: ad-hoc exec now waits (fairly, bounded by SANDBOX_EXEC_WAIT_MS) for a slot
  // instead of failing fast, so the old "3×200, 3×429" expectation is replaced by the
  // invariant it stood for: never more than 3 live sandboxes, every caller answered.
  const loopers = Array.from({ length: 6 }, () => fresh());
  await Promise.all(loopers.map((c) => c.ensure()));
  let peak = 0;
  let sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, (await get("/api/status")).sandboxes.active); await new Promise((r) => setTimeout(r, 40)); } })();
  const res = await Promise.all(loopers.map((c) => post("/api/sandbox/exec", { kind: "code", code: "while True:\n    pass" }, c)));
  sampling = false;
  await sampler;
  const c = res.map((x) => x.status);
  check(peak <= 3 && c.every((x) => x === 200 || x === 429), "6 parallel infinite loops (6 sessions) → ≤ 3 live sandboxes, each 200 or 429", `peak=${peak} ${c.join(",")}`);
  // Runs queue instead of failing: start 5 runs (5 sessions; 2 active runs per session max), sample /api/status.active
  const owners = Array.from({ length: 5 }, () => fresh());
  const plans = await Promise.all(owners.map((o) => post("/api/chat", { message: "Run this Python:\n```python\nprint(1)\n```" }, o).then((r) => r.data)));
  const runs = await Promise.all(plans.map((p, i) => post("/api/runs", { planId: p.plan.id }, owners[i])));
  let maxActive = 0, maxQueued = 0;
  for (let i = 0; i < 60; i++) {
    const st = await get("/api/status");
    maxActive = Math.max(maxActive, st.sandboxes.active);
    maxQueued = Math.max(maxQueued, st.sandboxes.queued);
    const all = await Promise.all(runs.map((x, j) => get(`/api/runs/${x.data.run.id}`, owners[j])));
    if (all.every((a) => ["succeeded", "failed"].includes(a.run.status))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const finals = await Promise.all(runs.map((x, j) => get(`/api/runs/${x.data.run.id}`, owners[j])));
  check(maxActive <= 3, "5 concurrent runs: active sandboxes never > 3", `maxActive=${maxActive} maxQueued=${maxQueued} final=${finals.map((f) => f.run.status).join(",")}`);
  const st = await get("/api/status");
  check(st.sandboxes.active === 0 && st.sandboxes.queued === 0, "slots released after runs", JSON.stringify(st.sandboxes));
}

console.log("\n# info exposure");
{
  // 2026-11-07: this check used to PASS while noting "every visitor sees every run";
  // runs are now private to the session that started them.
  const noSession = await anon(BASE, "GET", "/api/runs");
  check(noSession.status === 401, "GET /api/runs without a session → 401", `HTTP ${noSession.status}`);
  const list = await fresh().get("/api/runs");
  check(list.status === 200 && Array.isArray(list.data.runs) && list.data.runs.length === 0, "a new session sees 0 runs (not everyone's)", `${list.data?.runs?.length} runs visible`);
}

console.log(`\n${fails ? `${fails} FAIL` : "ALL PASS"}`);
process.exit(fails ? 1 : 0);
