// Adversarial black-box probe (T58) against a running ProofBox (mock mode).
//   node --import tsx tests/adversarial.probe.mjs http://127.0.0.1:3167
//   PROOFBOX_DEMO_TOKEN=<token> node --import tsx tests/adversarial.probe.mjs http://127.0.0.1:3168
// Bounded and non-destructive: mock sandboxes only, a few dozen requests.
// Against the pre-fix build (no /api/session) every client is a cookieless
// stranger, which is exactly what that build let anyone be — so the ownership
// checks FAIL there and PASS after the fixes. Exit 1 on any FAIL.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { anon, makeClient } from "./lib/pb-client.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:3167";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = process.env.PROOFBOX_DEMO_TOKEN;
let fails = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = (opts) => makeClient(BASE, opts);

const RESEARCH = "Open https://shop.example.com/pricing, capture evidence of the Pro plan price, and fill the contact form as a draft. Don't submit without my confirmation.";
async function planAndRun(who, message = RESEARCH) {
  const chat = await who.post("/api/chat", { message });
  if (chat.status !== 200) throw new Error(`chat → ${chat.status} ${chat.data?.error}`);
  const run = await who.post("/api/runs", { planId: chat.data.plan.id });
  if (run.status !== 202) throw new Error(`runs → ${run.status} ${run.data?.error}`);
  return { plan: chat.data.plan, run: run.data.run };
}
async function waitStatus(who, id, want) {
  for (let i = 0; i < 120; i++) {
    const r = await who.get(`/api/runs/${id}`);
    if (r.status === 200 && want.includes(r.data.run.status)) return r.data.run;
    await sleep(150);
  }
  throw new Error(`run ${id} never reached ${want}`);
}

const status = (await anon(BASE, "GET", "/api/status")).data;
console.log(`# target ${BASE} · mode=${status?.mode} · tokenRequired=${status?.access?.tokenRequired ?? status?.adhocExecToken} · exposure=${status?.access?.exposure ?? "n/a (pre-fix)"}`);

// ---------- access token: configured or absent ----------
console.log("\n# access token and sessions");
{
  const required = Boolean(status?.access?.tokenRequired);
  const noTok = await anon(BASE, "POST", "/api/session", {});
  const wrong = await anon(BASE, "POST", "/api/session", {}, { "x-proofbox-token": "wrong-token-wrong-token" });
  if (required) {
    check(noTok.status === 401, "token configured: POST /api/session without token → 401", `HTTP ${noTok.status}`);
    check(wrong.status === 401, "token configured: wrong token → 401", `HTTP ${wrong.status}`);
    const right = await anon(BASE, "POST", "/api/session", {}, { "x-proofbox-token": TOKEN ?? "" });
    check(right.status === 200, "token configured: right token → 200 (session)", `HTTP ${right.status}${TOKEN ? "" : " (PROOFBOX_DEMO_TOKEN not given to the probe)"}`);
  } else {
    check(noTok.status === 200, "token absent (local mode): a session is issued without a token", `HTTP ${noTok.status}`);
  }
  for (const [m, p, body] of [
    ["POST", "/api/chat", { message: "compute 1+1" }],
    ["POST", "/api/runs", { planId: "plan_x" }],
    ["GET", "/api/runs"],
    ["GET", "/api/runs/run_0000000000"],
    ["POST", "/api/runs/run_0000000000/confirm", { stepId: "s1", approve: true }],
    ["POST", "/api/sandbox/exec", { kind: "code", code: "print(1)" }],
  ]) {
    const r = await anon(BASE, m, p, body, TOKEN ? { "x-proofbox-token": TOKEN } : {});
    check(r.status === 401, `${m} ${p} without a session → 401${TOKEN ? " (even with the token: the token is not an identity)" : ""}`, `HTTP ${r.status}`);
  }
}

// ---------- ownership: two principals ----------
console.log("\n# ownership (principal A vs principal B)");
const A = client();
const B = client();
{
  const { plan, run } = await planAndRun(A);
  const paused = await waitStatus(A, run.id, ["awaiting_confirm"]);
  const gate = paused.steps.find((s) => s.status === "awaiting_confirm");

  const list = await B.get("/api/runs");
  const seen = (list.data?.runs ?? []).some((r) => r.id === run.id);
  check(list.status === 200 && !seen, "B's run list does not contain A's run", `HTTP ${list.status}, A's run ${seen ? "VISIBLE" : "not visible"}, ${list.data?.runs?.length ?? "?"} runs listed`);
  const read = await B.get(`/api/runs/${run.id}`);
  check(read.status === 404, "B cannot read A's run (404, same as missing)", `HTTP ${read.status}${read.data?.run ? ` — leaked ${Object.keys(read.data.run).join(",")}` : ""}`);
  const hijack = await B.post(`/api/runs/${run.id}/confirm`, { stepId: gate.stepId, approve: true });
  check(hijack.status === 404, "B cannot approve A's paused submit (H1)", `HTTP ${hijack.status}`);
  const redispatchB = await B.post("/api/runs", { planId: plan.id });
  check(redispatchB.status === 404, "B cannot dispatch A's plan", `HTTP ${redispatchB.status}`);
  const redispatchA = await A.post("/api/runs", { planId: plan.id });
  check(redispatchA.status === 409, "A cannot re-dispatch the same plan (single-use)", `HTTP ${redispatchA.status}`);

  const still = await A.get(`/api/runs/${run.id}`);
  check(still.data?.run?.status === "awaiting_confirm", "A's gate is untouched by B", `status=${still.data?.run?.status}`);

  // Replay + concurrent approve, by the owner.
  const [x, y] = await Promise.all([A.post(`/api/runs/${run.id}/confirm`, { stepId: gate.stepId, approve: true }), A.post(`/api/runs/${run.id}/confirm`, { stepId: gate.stepId, approve: true })]);
  check([x.status, y.status].sort().join() === "200,409", "two concurrent approves by the owner → one 200, one 409", `${x.status},${y.status}`);
  const done = await waitStatus(A, run.id, ["succeeded", "failed"]);
  const s = done.steps.find((z) => z.stepId === gate.stepId);
  check(s.status === "succeeded" && s.attempts.length === 1, "approved submit ran exactly once", `status=${s.status} attempts=${s.attempts.length}`);
  const replay = await A.post(`/api/runs/${run.id}/confirm`, { stepId: gate.stepId, approve: true });
  check(replay.status === 409, "replaying the approve after it ran → 409", `HTTP ${replay.status}`);
  const replayB = await B.post(`/api/runs/${run.id}/confirm`, { stepId: gate.stepId, approve: false });
  check(replayB.status === 404, "B replaying a decision on A's run → 404", `HTTP ${replayB.status}`);
}

// ---------- admission + queue bound + fairness + slot cleanup ----------
console.log("\n# queue: bound, fairness, cleanup (H2/H3)");
{
  const F = client(); // flooder
  const runs = [];
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const c = await F.post("/api/chat", { message: "Run this Python:\n```python\nwhile True:\n    pass\n```" });
    const r = c.status === 200 ? await F.post("/api/runs", { planId: c.data.plan.id }) : c;
    codes.push(r.status);
    if (r.status === 202) runs.push(r.data.run.id);
  }
  check(codes.filter((c) => c === 202).length <= 2 && codes.includes(429), "one principal: at most 2 active runs, then 429", codes.join(","));

  // Flood exec from F, in parallel, while a newcomer N asks for one exec.
  const flood = Array.from({ length: 10 }, () => F.post("/api/sandbox/exec", { kind: "code", code: "while True:\n    pass" }));
  await sleep(150);
  const st = (await anon(BASE, "GET", "/api/status")).data.sandboxes;
  const N = client();
  const t0 = Date.now();
  const mine = await N.post("/api/sandbox/exec", { kind: "code", code: 'print("newcomer")' });
  const waited = Date.now() - t0;
  const fl = (await Promise.all(flood)).map((r) => r.status);
  check(st.queued <= (st.maxQueued ?? 12), "queue stays bounded under a flood", `active=${st.active} queued=${st.queued} maxQueued=${st.maxQueued ?? "unbounded (pre-fix)"}`);
  check(fl.includes(429), "the flooder's excess requests are refused (429), not queued forever", fl.join(","));
  check(mine.status === 200 && mine.data?.receipt?.stdout === "newcomer", "a newcomer's exec is served despite the flood (not starved)", `HTTP ${mine.status} after ${waited} ms${mine.data?.error ? ` — ${mine.data.error}` : ""}`);

  for (const id of runs) await waitStatus(F, id, ["succeeded", "failed"]);
  let after;
  for (let i = 0; i < 40; i++) {
    after = (await anon(BASE, "GET", "/api/status")).data.sandboxes;
    if (after.active === 0 && after.queued === 0) break;
    await sleep(150);
  }
  check(after.active === 0 && after.queued === 0, "all slots released and queue empty afterwards", JSON.stringify(after));
}

// ---------- XFF spoofing ----------
console.log("\n# X-Forwarded-For spoofing (M1)");
{
  const S = client();
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await S.post("/api/sandbox/exec", { kind: "code", code: "print(1)" }, { "x-forwarded-for": `203.0.113.${i}, 198.51.100.${i}` })).status);
  const ok = codes.filter((c) => c === 200).length;
  check(ok <= 20, "one session with 25 rotating XFF values is still limited (≤ 20/min)", `${ok}/25 × 200`);
  const spoofSessions = [];
  for (let i = 0; i < 3; i++) spoofSessions.push((await anon(BASE, "POST", "/api/session", {}, { "x-forwarded-for": `192.0.2.${i}`, ...(TOKEN ? { "x-proofbox-token": TOKEN } : {}) })).status);
  check(spoofSessions.every((c) => c === 200 || c === 429), "session minting with spoofed XFF never errors", spoofSessions.join(","));
}

// ---------- receipts via verify-receipt ----------
console.log("\n# receipts: valid / tampered / unreachable base / bad key (L4)");
{
  const V = client();
  const res = await V.post("/api/sandbox/exec", { kind: "code", code: 'print("receipt")' });
  const dir = mkdtempSync(join(tmpdir(), "pb-adv-"));
  const good = join(dir, "good.json");
  const bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify(res.data.receipt));
  writeFileSync(bad, JSON.stringify({ ...res.data.receipt, exitCode: 1 }));
  const vr = (...a) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(ROOT, "scripts/verify-receipt.mjs"), ...a], { encoding: "utf8", timeout: 20_000 }).status;
  check(vr(good, "--base", BASE) === 0, "valid receipt, key from --base → exit 0");
  check(vr(bad, "--base", BASE) === 1, "tampered receipt → exit 1");
  check(vr(good, "--base", "http://127.0.0.1:9") === 3, "unreachable --base → exit 3 (key unavailable, receipt not judged)", `exit ${vr(good, "--base", "http://127.0.0.1:9")}`);
  check(vr(good, "--key", "bm90LWEta2V5") === 3, "malformed --key → exit 3", `exit ${vr(good, "--key", "bm90LWEta2V5")}`);
  const pk = (await anon(BASE, "GET", "/api/receipts/public-key")).data;
  check(vr(good, "--key", pk.spki, "--key-id", pk.keyId) === 0, "pinned --key + --key-id → exit 0");
  check(vr(good, "--key", pk.spki, "--key-id", "0000000000000000") === 1, "pinned key but wrong --key-id → exit 1");
}

console.log(`\n${fails ? `${fails} FAIL` : "ALL PASS"}`);
process.exit(fails ? 1 : 0);
