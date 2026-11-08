// Adversarial regression tests (T58) that use only interfaces which also exist
// in the pre-fix code, so the same file can be run against the 2026-11-07 backup
// to show it failing there. No server needed.
//   npm test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { clientIp } from "@/lib/rate-limit";
import { runInSandbox } from "@/lib/sandbox";
import { isForbiddenTarget } from "@/lib/sandbox/fixtures";
import { publicKeyInfo } from "@/lib/sandbox/signing";

process.env.MOCK = "1";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("L1: isForbiddenTarget covers more ranges and canonical forms", () => {
  const blocked = [
    "http://[::7f00:1]/", // IPv4-compatible loopback
    "http://[::127.0.0.1]/", // same, dotted (normalised by WHATWG URL)
    "http://[64:ff9b::7f00:1]/", // NAT64 → 127.0.0.1
    "http://[2002:7f00:1::]/", // 6to4 → 127.0.0.1
    "http://[2001:0:4136:e378::1]/", // Teredo
    "http://198.18.0.1/",
    "http://198.19.255.1/",
    "http://224.0.0.1/",
    "http://239.255.255.250/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
    "http://192.0.0.1/",
    "http://[ff02::1]/",
    "http://localhost./", // trailing dot
    "http://LOCALHOST../",
    "http://db.internal/",
    "http://printer.local/",
  ];
  for (const u of blocked) it(`blocks ${u}`, () => assert.ok(isForbiddenTarget(new URL(u)), u));
  for (const u of ["https://shop.example.com/", "http://8.8.8.8/", "http://[2606:4700::1111]/", "https://172.32.0.1/"])
    it(`still allows public ${u}`, () => assert.equal(isForbiddenTarget(new URL(u)), null));
});

const code = (c: string) => runInSandbox({ taskId: "t", stepId: "s", attempt: 1, request: { kind: "code", language: "python", code: c } });

describe("L2: the mock never signs a wrong Python result", () => {
  const cases: [string, string][] = [
    ["7//2", "3"],
    ["-7%3", "2"],
    ["-7//2", "-4"],
    ["-2**2", "-4"],
    ["2**10", "1024"],
    ["6 * 7", "42"],
  ];
  for (const [expr, want] of cases)
    it(`print(${expr}) → ${want} (Python semantics)`, async () => {
      const r = await code(`print(${expr})`);
      assert.equal(r.stdout, want);
    });
  for (const expr of ["1/0", "7/2", "0.1+0.2", "2**-1", "1//0"])
    it(`print(${expr}) is "not evaluated", never a guessed number`, async () => {
      const r = await code(`print(${expr})`);
      assert.match(r.stdout, /^<mock: not evaluated: /);
    });
  it("the evaluator does not run host JavaScript", async () => {
    const r = await code("print((()=>1)())");
    assert.match(r.stdout, /not evaluated/);
  });
});

describe("L3: simulated stderr is labelled inside the signed receipt", () => {
  it("a blocked docker call says it was simulated", async () => {
    const r = await code("import os\nos.system('docker ps')");
    assert.ok(r.stderr.length > 0);
    assert.match(r.stderr.split("\n")[0], /simulated/i);
  });
  it("an OOM kill says it was simulated", async () => {
    const r = await code("x = bytearray(10**10)");
    assert.equal(r.killedBy, "memory");
    assert.match(r.stderr, /^\[mock\] simulated/);
  });
});

describe("M1: X-Forwarded-For is not trusted unless a proxy is configured", () => {
  const req = (h: Record<string, string>) => new Request("http://127.0.0.1/api/x", { headers: h });
  it("a spoofed left-most XFF value is not the client IP", () => {
    delete process.env.PROOFBOX_TRUST_PROXY;
    assert.notEqual(clientIp(req({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
    assert.notEqual(clientIp(req({ "x-real-ip": "203.0.113.10" })), "203.0.113.10");
  });
  it("two different spoofed values do not give two different identities", () => {
    delete process.env.PROOFBOX_TRUST_PROXY;
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.1" })), clientIp(req({ "x-forwarded-for": "203.0.113.2" })));
  });
  it("with one trusted proxy, the right-most entry (added by the proxy) wins", () => {
    process.env.PROOFBOX_TRUST_PROXY = "1";
    try {
      assert.equal(clientIp(req({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" })), "198.51.100.7");
      assert.notEqual(clientIp(req({ "x-forwarded-for": "not-an-ip" })), "not-an-ip");
    } finally {
      delete process.env.PROOFBOX_TRUST_PROXY;
    }
  });
});

describe("L4: verify-receipt exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-verify-"));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", join(ROOT, "scripts/verify-receipt.mjs"), ...args], { encoding: "utf8", timeout: 20_000 });
  const files = (async () => {
    const r = await code('print("hello")');
    const good = join(dir, "good.json");
    const bad = join(dir, "tampered.json");
    writeFileSync(good, JSON.stringify(r));
    writeFileSync(bad, JSON.stringify({ ...r, isolation: { ...r.isolation, hostTouched: true } }));
    return { good, bad, spki: publicKeyInfo().spki };
  })();

  it("valid receipt + pinned key → 0", async () => {
    const f = await files;
    assert.equal(run(f.good, "--key", f.spki).status, 0);
  });
  it("tampered receipt → 1", async () => {
    const f = await files;
    assert.equal(run(f.bad, "--key", f.spki).status, 1);
  });
  it("unreachable --base → 3 (key unavailable), not 1 (invalid)", async () => {
    const f = await files;
    const r = run(f.good, "--base", "http://127.0.0.1:9"); // nothing listens on the discard port
    assert.equal(r.status, 3, r.stderr);
  });
  it("malformed --key → 3, not 1", async () => {
    const f = await files;
    assert.equal(run(f.good, "--key", "bm90LWEta2V5").status, 3);
  });
  it("no key source → 2 (no default base: never fetches a key from whatever runs on :3000)", async () => {
    const f = await files;
    assert.equal(run(f.good).status, 2);
  });
  it("unreadable receipt file → 2", () => assert.equal(run(join(dir, "missing.json"), "--key", "AAAA").status, 2));
});
