// Startup/config probe (T58): starts `next start` from a BUILT project dir on one
// port with different environments, checks the outcome, and stops each server
// by the PID it started (never anything else).
//   node tests/config.probe.mjs [projectDir=.] [port=3168]
// Covers: public mode without token/key refuses to start; a malformed
// RECEIPT_SIGNING_KEY refuses to start; a stable key keeps its keyId across
// restarts; local mode refuses a non-loopback Host; public mode with token +
// key starts and issues HttpOnly/SameSite=Strict/Secure session cookies only
// with the token. Throwaway keys are generated here and never printed.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

const DIR = resolve(process.argv[2] ?? ".");
const PORT = Number(process.argv[3] ?? 3168);
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** GET with an explicit Host header (fetch silently replaces Host; node:http sends it). */
const getWithHost = (path, host) =>
  new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: PORT, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", reject);
    r.end();
  });

const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PROOFBOX_|RECEIPT_|SANDBOX_|SESSION|MOCK$)/.test(k)));

/** Start a server; resolve { pid, exited, code, log } once it answers /api/status or exits (max 30 s). */
async function start(env) {
  const child = spawn(join(DIR, "node_modules/.bin/next"), ["start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: DIR, env: { ...CLEAN, MOCK: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const s = { pid: child.pid, exited: false, code: null, log: "", child };
  child.stdout.on("data", (d) => (s.log += d));
  child.stderr.on("data", (d) => (s.log += d));
  child.on("exit", (code) => Object.assign(s, { exited: true, code }));
  for (let i = 0; i < 150 && !s.exited; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(1000) });
      s.httpStatus = r.status;
      s.status = await r.json().catch(() => null);
      // Give a refusing server a moment to exit after it started listening.
      await sleep(300);
      break;
    } catch {
      await sleep(200);
    }
  }
  return s;
}
async function stop(s) {
  if (s.exited) return;
  s.child.kill("SIGTERM");
  for (let i = 0; i < 50 && !s.exited; i++) await sleep(100);
  if (!s.exited) s.child.kill("SIGKILL");
  await sleep(300);
}
const ed25519 = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const token = randomBytes(18).toString("base64url");

console.log(`# config probe · dir=${DIR} · port=${PORT}`);

{
  const s = await start({ PROOFBOX_PUBLIC: "1" });
  const refused = s.exited ? s.code !== 0 : s.httpStatus === 503;
  check(refused, "PROOFBOX_PUBLIC=1 without token or signing key → refuses to start", s.exited ? `exited code ${s.code}` : `still running, /api/status HTTP ${s.httpStatus}`);
  check(!/[A-Za-z0-9+/]{40,}/.test(s.log), "refusal log contains no key material");
  await stop(s);
}
{
  const s = await start({ PROOFBOX_PUBLIC: "1", PROOFBOX_DEMO_TOKEN: token });
  check(s.exited ? s.code !== 0 : s.httpStatus === 503, "PROOFBOX_PUBLIC=1 with token but no RECEIPT_SIGNING_KEY → refuses", s.exited ? `exited code ${s.code}` : `running, HTTP ${s.httpStatus}`);
  await stop(s);
}
for (const [name, key] of [
  ["truncated DER", "MC4CAQAwBQYDK2VwBCIEI"],
  ["RSA key", generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")],
]) {
  const s = await start({ RECEIPT_SIGNING_KEY: key });
  check(s.exited && s.code !== 0, `malformed RECEIPT_SIGNING_KEY (${name}) → refuses to start (not at the first receipt)`, s.exited ? `exited code ${s.code}` : `running, HTTP ${s.httpStatus}`);
  check(!s.log.includes(key.slice(8, 40)), `refusal log does not echo the key (${name})`);
  await stop(s);
}
{
  const key = ed25519();
  const a = await start({ RECEIPT_SIGNING_KEY: key });
  const ka = a.exited ? null : await (await fetch(`${BASE}/api/receipts/public-key`)).json();
  await stop(a);
  const b = await start({ RECEIPT_SIGNING_KEY: key });
  const kb = b.exited ? null : await (await fetch(`${BASE}/api/receipts/public-key`)).json();
  await stop(b);
  check(ka && kb && ka.keyId === kb.keyId && ka.ephemeral === false, "stable RECEIPT_SIGNING_KEY → same keyId after a restart, ephemeral:false", `${ka?.keyId} / ${kb?.keyId}`);
  const c = await start({});
  const kc = c.exited ? null : await (await fetch(`${BASE}/api/receipts/public-key`)).json();
  await stop(c);
  const d = await start({});
  const kd = d.exited ? null : await (await fetch(`${BASE}/api/receipts/public-key`)).json();
  await stop(d);
  check(kc && kd && kc.keyId !== kd.keyId && kc.ephemeral === true, "no key → ephemeral, new keyId per start (documented)", `${kc?.keyId} / ${kd?.keyId}`);
}
{
  const s = await start({});
  const evil = await getWithHost("/api/status", "proofbox.evil.example");
  const lan = await getWithHost("/api/runs", "192.168.1.20:3000");
  check(evil === 403 && lan === 403, "local mode: request with a non-loopback Host → 403", `evil.example ${evil}, LAN IP ${lan}`);
  const ok = await fetch(`${BASE}/api/status`);
  check(ok.status === 200, "local mode: loopback Host → 200", `HTTP ${ok.status}`);
  const xo = await fetch(`${BASE}/api/session`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  check(xo.status === 403, "cross-origin POST /api/session → 403", `HTTP ${xo.status}`);
  await stop(s);
}
{
  const s = await start({ PROOFBOX_PUBLIC: "1", PROOFBOX_DEMO_TOKEN: token, RECEIPT_SIGNING_KEY: ed25519(), PROOFBOX_TRUST_PROXY: "1" });
  check(!s.exited && s.httpStatus === 200 && s.status?.access?.exposure === "public", "public mode with token + key starts", s.exited ? `exited ${s.code}: ${s.log.slice(-200)}` : `HTTP ${s.httpStatus}`);
  if (!s.exited) {
    const hostOk = await getWithHost("/api/status", "proofbox.example");
    check(hostOk === 200, "public mode: any Host is accepted", `HTTP ${hostOk}`);
    const no = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(no.status === 401, "public mode: session without token → 401", `HTTP ${no.status}`);
    const yes = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json", "x-proofbox-token": token }, body: "{}" });
    const sc = yes.headers.getSetCookie().join("; ");
    check(yes.status === 200 && /HttpOnly/i.test(sc) && /SameSite=strict/i.test(sc) && /Secure/i.test(sc), "public mode: token → session cookie HttpOnly; SameSite=Strict; Secure", `HTTP ${yes.status}`);
    // With one trusted proxy, minting is limited per right-most XFF entry (10/min by default).
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json", "x-proofbox-token": token, "x-forwarded-for": `10.9.9.${i}, 198.51.100.77` }, body: "{}" })).status);
    check(codes.filter((c) => c === 429).length >= 1, "trusted proxy: rotating the spoofable left part of XFF does not escape the per-IP mint limit", codes.join(","));
  }
  await stop(s);
}

console.log(`\n${fails ? `${fails} FAIL` : "ALL PASS"}`);
process.exit(fails ? 1 : 0);
