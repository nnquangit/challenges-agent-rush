// Unit tests for the trust/ownership model, the fair slot pool and startup
// config checks (T58). These modules are new in the security fixes, so this file
// cannot run against the pre-fix backup; its HTTP twin is tests/adversarial.probe.mjs.
//   npm test
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { isLoopbackHost, newPrincipal, precheck, requireSession, signSession, verifySession, SESSION_COOKIE } from "@/lib/access";
import { configProblems } from "@/lib/config";
import { confirmStep, RunRefused, startRun } from "@/lib/orchestrator";
import { checkSigningKey, SigningKeyError } from "@/lib/sandbox/signing";
import { SandboxBusy, SlotPool, type SlotLimits } from "@/lib/sandbox/slots";
import { evalPythonInt } from "@/lib/sandbox/py-arith";
import { ownRun, store } from "@/lib/store";
import type { Plan } from "@/lib/types";

process.env.MOCK = "1";

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  const restore = () => {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
  } catch (e) {
    restore();
    throw e;
  }
}

describe("sessions: server-issued principal", () => {
  it("a signed session verifies and yields its principal", () => {
    const p = newPrincipal();
    assert.equal(verifySession(signSession(p))?.principal, p);
  });
  it("two sessions are two principals", () => assert.notEqual(newPrincipal(), newPrincipal()));
  it("forged, edited or truncated cookies are refused", () => {
    const v = signSession(newPrincipal());
    const [ver, p, iat, mac] = v.split(".");
    const other = newPrincipal();
    for (const bad of [`${ver}.${other}.${iat}.${mac}`, `${ver}.${p}.${(Number.parseInt(iat, 36) + 1).toString(36)}.${mac}`, `${ver}.${p}.${iat}.${mac.slice(0, -2)}AA`, `${ver}.${p}.${iat}`, "", "pb1.x.y.z"])
      assert.equal(verifySession(bad), null, bad);
  });
  it("expired sessions are refused", () => {
    const issued = Date.now() - 13 * 60 * 60_000;
    assert.equal(verifySession(signSession(newPrincipal(), issued)), null);
  });
  it("rotating the access token ends existing sessions", () =>
    withEnv({ PROOFBOX_DEMO_TOKEN: "a".repeat(20) }, () => {
      const v = signSession(newPrincipal());
      assert.ok(verifySession(v));
      process.env.PROOFBOX_DEMO_TOKEN = "b".repeat(20);
      assert.equal(verifySession(v), null);
    }));
  it("requireSession: no cookie → 401, valid cookie → principal", () => {
    const none = requireSession(new Request("http://127.0.0.1:3167/api/runs", { headers: { host: "127.0.0.1:3167" } }));
    assert.ok(none instanceof Response && none.status === 401);
    const p = newPrincipal();
    const ok = requireSession(new Request("http://127.0.0.1:3167/api/runs", { headers: { host: "127.0.0.1:3167", cookie: `${SESSION_COOKIE}=${signSession(p)}` } }));
    assert.deepEqual(ok, { principal: p });
  });
});

describe("precheck: exposure, Host, Origin", () => {
  const req = (headers: Record<string, string>, method = "POST") => new Request("http://x/api/chat", { method, headers });
  it("local mode refuses a non-loopback Host (accidental exposure, DNS rebinding of the app)", () =>
    withEnv({ PROOFBOX_PUBLIC: undefined }, () => {
      assert.equal(precheck(req({ host: "evil.example" }))?.status, 403);
      assert.equal(precheck(req({ host: "192.168.1.20:3000" }))?.status, 403);
      assert.equal(precheck(req({ host: "127.0.0.1:3167" })), null);
      assert.equal(precheck(req({ host: "localhost:3000" })), null);
      assert.equal(precheck(req({ host: "[::1]:3000" })), null);
    }));
  it("cross-origin POSTs are refused", () => {
    assert.equal(precheck(req({ host: "127.0.0.1:3167", origin: "https://evil.example" }))?.status, 403);
    assert.equal(precheck(req({ host: "127.0.0.1:3167", origin: "http://127.0.0.1:3167" })), null);
  });
  it("isLoopbackHost", () => {
    for (const h of ["localhost", "a.localhost", "127.0.0.1", "127.9.9.9", "[::1]"]) assert.ok(isLoopbackHost(h), h);
    for (const h of ["localhost.evil.com", "127.0.0.1.nip.io", "0.0.0.0", "10.0.0.1", ""]) assert.ok(!isLoopbackHost(h), h);
  });
  it("public mode without token/key → config error → 503 on every request", () =>
    withEnv({ PROOFBOX_PUBLIC: "1", PROOFBOX_DEMO_TOKEN: undefined, RECEIPT_SIGNING_KEY: undefined }, () => {
      const p = configProblems();
      assert.ok(p.some((x) => x.includes("PROOFBOX_DEMO_TOKEN")) && p.some((x) => x.includes("RECEIPT_SIGNING_KEY")));
      assert.equal(precheck(req({ host: "proofbox.example" }))?.status, 503);
    }));
  it("public mode with token and key → no config errors, any Host", () =>
    withEnv({ PROOFBOX_PUBLIC: "1", PROOFBOX_DEMO_TOKEN: "t".repeat(24), RECEIPT_SIGNING_KEY: "x" }, () => {
      assert.deepEqual(configProblems(), []);
      assert.equal(precheck(req({ host: "proofbox.example" }, "GET")), null);
    }));
  it("short token, bad PROOFBOX_PUBLIC or PROOFBOX_TRUST_PROXY are config errors", () =>
    withEnv({ PROOFBOX_DEMO_TOKEN: "short", PROOFBOX_PUBLIC: "yes", PROOFBOX_TRUST_PROXY: "all" }, () => assert.equal(configProblems().length, 3)));
});

describe("L5: RECEIPT_SIGNING_KEY is validated, never echoed", () => {
  const pkcs8 = (type: "ed25519" | "rsa") =>
    (type === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 1024 }) : generateKeyPairSync("ed25519")).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  for (const [name, value] of [
    ["not base64", "%%%not-base64%%%"],
    ["truncated DER", "MC4CAQAwBQYDK2VwBCIEI"],
    ["RSA key", pkcs8("rsa")],
  ] as const)
    it(`refuses ${name}`, () =>
      withEnv({ RECEIPT_SIGNING_KEY: value }, () => {
        assert.throws(() => checkSigningKey(), (e: unknown) => e instanceof SigningKeyError && !e.message.includes(value.slice(4, 24)));
      }));
  it("a stable key gives the same keyId on every load (receipts survive restarts)", () =>
    withEnv({ RECEIPT_SIGNING_KEY: pkcs8("ed25519") }, () => {
      const a = checkSigningKey();
      const b = checkSigningKey();
      assert.equal(a.keyId, b.keyId);
      assert.equal(a.ephemeral, false);
    }));
  it("no key → ephemeral, a different keyId each load", () =>
    withEnv({ RECEIPT_SIGNING_KEY: undefined }, () => {
      const a = checkSigningKey();
      assert.equal(a.ephemeral, true);
      assert.notEqual(a.keyId, checkSigningKey().keyId);
    }));
});

describe("slot pool: bounded, fair, cleaned up", () => {
  const L: SlotLimits = { maxConcurrent: 2, slotsPerPrincipal: 2, maxQueued: 4, queuePerPrincipal: 3 };
  const tick = () => new Promise((r) => setImmediate(r));

  it("never more than maxConcurrent live; release is idempotent", async () => {
    const pool = new SlotPool(() => L);
    const a = await pool.acquire("A", 0);
    const b = await pool.acquire("B", 0);
    await assert.rejects(pool.acquire("C", 0), SandboxBusy);
    a();
    a();
    assert.equal(pool.stats().active, 1);
    b();
    assert.deepEqual([pool.stats().active, pool.stats().queued], [0, 0]);
  });
  it("one principal cannot hold every slot", async () => {
    const pool = new SlotPool(() => ({ ...L, maxConcurrent: 3, slotsPerPrincipal: 2 }));
    await pool.acquire("A", 0);
    await pool.acquire("A", 0);
    await assert.rejects(pool.acquire("A", 0), SandboxBusy);
    const b = await pool.acquire("B", 0); // the third slot is still there for someone else
    b();
  });
  it("queue is bounded globally and per principal (429, not unbounded waiting)", async () => {
    const pool = new SlotPool(() => L);
    const held = [await pool.acquire("A", 0), await pool.acquire("A", 0)];
    const waits = [1, 2, 3].map(() => pool.acquire("A", 60_000));
    await assert.rejects(pool.acquire("A", 60_000), /already have 3 requests waiting/);
    const bWait = pool.acquire("B", 60_000);
    await assert.rejects(pool.acquire("C", 60_000), /queue is full/);
    assert.equal(pool.stats().queued, 4);
    // Each waiter releases as soon as it is granted, so the queue drains.
    const drained = Promise.all([...waits, bWait].map((w) => w.then((release) => release())));
    held.forEach((r) => r());
    await drained;
    await tick();
    assert.deepEqual([pool.stats().active, pool.stats().queued, pool.stats().principalsWaiting, pool.stats().principalsActive], [0, 0, 0, 0]);
  });
  it("freed slots go round-robin: a flooder does not starve a newcomer", async () => {
    const pool = new SlotPool(() => ({ maxConcurrent: 1, slotsPerPrincipal: 1, maxQueued: 10, queuePerPrincipal: 10 }));
    const order: string[] = [];
    const first = await pool.acquire("A", 0);
    const flood = [1, 2, 3].map(() => pool.acquire("A", 60_000).then((r) => (order.push("A"), r)));
    const newcomer = pool.acquire("B", 60_000).then((r) => (order.push("B"), r));
    first();
    const r1 = await flood[0];
    r1();
    const rb = await newcomer;
    assert.deepEqual(order, ["A", "B"], "B is served right after A's first waiter, not after all of A's");
    rb();
    for (const p of flood.slice(1)) (await p)();
    assert.equal(pool.stats().active, 0);
  });
  it("a waiter that times out leaves the queue and gets SandboxBusy", async () => {
    const pool = new SlotPool(() => L);
    const held = [await pool.acquire("A", 0), await pool.acquire("B", 0)];
    await assert.rejects(pool.acquire("C", 30), /no sandbox slot within 30 ms/);
    assert.deepEqual([pool.stats().queued, pool.stats().principalsWaiting], [0, 0]);
    held.forEach((r) => r());
  });
});

describe("ownership: runs belong to the session that started them", () => {
  const plan = (owner: string): Plan => ({
    id: `plan_${Math.random().toString(16).slice(2)}`,
    intent: "browser",
    title: "t",
    summary: "s",
    createdAt: "now",
    planner: "test",
    owner,
    egressAllowlist: ["shop.example.com"],
    steps: [{ id: "s1", kind: "browser", title: "submit", description: "", requiresConfirm: true, browser: { action: "submit", url: "https://shop.example.com/contact" } }],
  });
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("another principal cannot read, dispatch or confirm; replay is 409", async () => {
    const A = newPrincipal();
    const B = newPrincipal();
    const pa = plan(A);
    store.plans.set(pa.id, pa);
    assert.throws(() => startRun(pa, B), (e: unknown) => e instanceof RunRefused && e.status === 404);
    const run = startRun(pa, A);
    await waitFor(() => run.status === "awaiting_confirm");
    assert.equal(ownRun(run.id, B), undefined);
    assert.throws(() => confirmStep(run.id, "s1", true, B), (e: unknown) => e instanceof RunRefused && e.status === 404);
    assert.equal(run.steps[0].status, "awaiting_confirm", "B's attempt changed nothing");
    confirmStep(run.id, "s1", false, A);
    assert.throws(() => confirmStep(run.id, "s1", true, A), (e: unknown) => e instanceof RunRefused && e.status === 409);
    await waitFor(() => run.status === "succeeded" || run.status === "failed");
    assert.equal(run.steps[0].status, "skipped");
    assert.equal(run.steps[0].attempts.length, 0);
  });
  it("plans are single-use: a second dispatch is 409", async () => {
    const A = newPrincipal();
    const pa = plan(A);
    store.plans.set(pa.id, pa);
    const run = startRun(pa, A);
    assert.throws(() => startRun(pa, A), (e: unknown) => e instanceof RunRefused && e.status === 409);
    await waitFor(() => run.status === "awaiting_confirm");
    confirmStep(run.id, "s1", false, A);
  });
  it("active runs per principal are capped (429)", async () => {
    const A = newPrincipal();
    const runs = [plan(A), plan(A)].map((p) => (store.plans.set(p.id, p), startRun(p, A)));
    const third = plan(A);
    store.plans.set(third.id, third);
    assert.throws(() => startRun(third, A), (e: unknown) => e instanceof RunRefused && e.status === 429);
    assert.equal(third.runId, undefined, "a refused dispatch does not use up the plan");
    for (const r of runs) {
      await waitFor(() => r.status === "awaiting_confirm");
      confirmStep(r.id, "s1", false, A);
    }
  });
});

describe("py-arith (exact, no host eval)", () => {
  it("matches Python on precedence and floor semantics", () => {
    const t: [string, string | null][] = [["2**3**2", "512"], ["8 % 3 ** 2", "8"], ["-(7)//2", "-4"], ["7%-3", "-2"], ["1_000", "1000"], ["07", null], ["2**99999", null], ["abs(1)", null], ["3/2", null]];
    for (const [e, want] of t) assert.equal(evalPythonInt(e)?.toString() ?? null, want, e);
  });
});
