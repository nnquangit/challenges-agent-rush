// Unit tests for the confinement rules — no server needed.
//   npm test   (node --test with tsx)
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";

import { MAX_LIMITS, resolveLimits } from "@/lib/config";
import { containmentVerdict } from "@/lib/containment";
import { MockLlm } from "@/lib/llm/mock-llm";
import { enforcePolicy, MAX_PLAN_STEPS, PlanRejected, userHosts } from "@/lib/policy";
import { rateLimit } from "@/lib/rate-limit";
import { receiptPayload } from "@/lib/receipt-canonical";
import { MOCK_CANARY, runInSandbox, SandboxBusy } from "@/lib/sandbox";
import { isForbiddenTarget } from "@/lib/sandbox/fixtures";
import { buildSandboxEnv, REDACTED, redactText } from "@/lib/sandbox/redact";
import { publicKeyInfo } from "@/lib/sandbox/signing";
import type { Plan, Receipt } from "@/lib/types";

process.env.MOCK = "1";

describe("isForbiddenTarget", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/", // decimal form of 169.254.169.254 — WHATWG URL normalises it
    "http://0xa9fea9fe/",
    "http://169.254.10.1/",
    "http://metadata.google.internal/",
    "http://[fd00:ec2::254]/",
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://127.0.0.1/",
    "http://0.0.0.0/",
    "http://[::1]:8080/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[fd12::1]/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "file:///etc/passwd",
    "ftp://example.com/",
  ];
  for (const u of blocked) it(`blocks ${u}`, () => assert.ok(isForbiddenTarget(new URL(u)), u));
  for (const u of ["https://shop.example.com/pricing", "https://172.32.0.1/", "https://100.128.0.1/"]) {
    it(`allows public ${u}`, () => assert.equal(isForbiddenTarget(new URL(u)), null));
  }
});

describe("secret hygiene", () => {
  it("keeps scoped secret names, drops values and unscoped secrets", () => {
    const { env, redactions } = buildSandboxEnv({ VULTR_INFERENCE_API_KEY: "real-value-123", AWS_SECRET_ACCESS_KEY: "x".repeat(20), HOME: "/Users/me", LANG: "en_US" });
    assert.equal(env.VULTR_INFERENCE_API_KEY, REDACTED);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.HOME, "/sandbox");
    assert.equal(env.LANG, "en_US");
    assert.equal(redactions, 1);
  });
  it("scrubs host secret values and token-shaped strings from output", () => {
    const r = redactText("key=hunter2-secret and sk-abcdefghijklmnopqrstu", { MY_TOKEN: "hunter2-secret" });
    assert.ok(!r.text.includes("hunter2-secret") && !r.text.includes("sk-abcdefghijklmnopqrstu"));
    assert.equal(r.count, 2);
  });
});

describe("resolveLimits", () => {
  it("never exceeds the hard ceilings", () => {
    assert.deepEqual(resolveLimits({ timeoutMs: 10 ** 9, memoryMb: 10 ** 9 }), MAX_LIMITS);
  });
  it("allows asking for less", () => assert.equal(resolveLimits({ memoryMb: 64 }).memoryMb, 64));
});

const llmPlan = (over: Partial<Plan> = {}): Plan => ({
  id: "plan_x",
  intent: "browser",
  title: "t",
  summary: "s",
  createdAt: "now",
  planner: "test",
  steps: [{ id: "a", kind: "browser", title: "open", description: "", browser: { action: "navigate", url: "https://shop.example.com/" } }],
  ...over,
});

describe("policy (control plane, not planner)", () => {
  it("inserts code probes for every code plan", async () => {
    const plan = enforcePolicy(await new MockLlm().plan({ message: "compute 2+2" }), "compute 2+2");
    const probes = plan.steps.filter((s) => s.probe);
    assert.equal(probes.length, 2);
    assert.ok(probes.every((s) => s.addedBy === "policy"));
    assert.deepEqual(plan.steps.map((s) => s.id), ["s1", "s2", "s3"]);
  });
  it("clears probe flags the LLM set itself", () => {
    const raw = llmPlan({ intent: "code", steps: [{ id: "x", kind: "code", title: "fake probe", description: "", code: "print(1)", probe: true }] });
    const plan = enforcePolicy(raw, "");
    assert.equal(plan.steps[0].probe, undefined);
    assert.deepEqual(plan.policy?.probeFlagsCleared, ["fake probe"]);
  });
  it("forces confirm on submit and runs probes before the gate", () => {
    const raw = llmPlan({
      steps: [
        { id: "a", kind: "browser", title: "open", description: "", browser: { action: "navigate", url: "https://shop.example.com/" } },
        { id: "b", kind: "browser", title: "submit", description: "", browser: { action: "submit", url: "https://shop.example.com/" } },
      ],
    });
    const plan = enforcePolicy(raw, "https://shop.example.com/");
    const submit = plan.steps.find((s) => s.browser?.action === "submit")!;
    assert.equal(submit.requiresConfirm, true);
    assert.ok(plan.steps.findIndex((s) => s.probe) < plan.steps.indexOf(submit));
    assert.deepEqual(plan.policy?.confirmForced, ["submit"]);
  });
  it("egress = hosts the user named ∩ server allowlist; LLM list ignored", () => {
    const raw = llmPlan({ egressAllowlist: ["evil.example.org", "shop.example.com"] });
    const plan = enforcePolicy(raw, "see https://shop.example.com/ and https://other.example.net/x");
    assert.deepEqual(plan.egressAllowlist, ["shop.example.com"]);
    assert.deepEqual(plan.policy?.egressRefused, ["other.example.net"]);
    assert.deepEqual(enforcePolicy(raw, "no urls").egressAllowlist, []);
  });
  it("prompt-injected allowlist hosts never get in", () => {
    const raw = llmPlan({ egressAllowlist: ["attacker.example"] });
    assert.ok(!enforcePolicy(raw, "https://shop.example.com/").egressAllowlist!.includes("attacker.example"));
  });
  const reject: [string, unknown][] = [
    ["not an object", "plan"],
    ["bad intent", llmPlan({ intent: "shell" as never })],
    ["no steps", llmPlan({ steps: [] })],
    ["too many steps", llmPlan({ steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({ id: `${i}`, kind: "code" as const, title: "t", description: "", code: "print(1)" })) })],
    ["bad kind", llmPlan({ steps: [{ id: "a", kind: "shell" as never, title: "t", description: "" }] })],
    ["javascript: url", llmPlan({ steps: [{ id: "a", kind: "browser", title: "t", description: "", browser: { action: "navigate", url: "javascript:alert(1)" } }] })],
    ["bad action", llmPlan({ steps: [{ id: "a", kind: "browser", title: "t", description: "", browser: { action: "download" as never, url: "https://a.b/" } }] })],
    ["huge code", llmPlan({ steps: [{ id: "a", kind: "code", title: "t", description: "", code: "x".repeat(20_001) }] })],
    ["empty code", llmPlan({ steps: [{ id: "a", kind: "code", title: "t", description: "", code: "  " }] })],
  ];
  for (const [name, plan] of reject) it(`rejects plan: ${name}`, () => assert.throws(() => enforcePolicy(plan, ""), PlanRejected));
  it("userHosts parses only http(s) URLs", () => assert.deepEqual(userHosts("a https://A.example.com/x. b ftp://x.y c http://b.example.com"), ["a.example.com", "b.example.com"]));
});

describe("runInSandbox + receipts (MockSandbox)", () => {
  const code = (c: string, extra: object = {}) => runInSandbox({ taskId: "t", stepId: "s", attempt: 1, request: { kind: "code", language: "python", code: c }, ...extra });

  it("seals a receipt that verifies, and tampering with isolation breaks it", async () => {
    const r = await code('print(os.environ.get("PROOFBOX_CANARY_API_KEY"))');
    assert.ok(!JSON.stringify(r).includes(MOCK_CANARY), "canary must never appear in a receipt");
    assert.equal(r.isolation.destroyed, true);
    assert.equal(r.clock, "simulated");
    const key = createPublicKey({ key: Buffer.from(publicKeyInfo().spki, "base64"), format: "der", type: "spki" });
    const ok = (x: Receipt) => verify(null, Buffer.from(receiptPayload(x as never)), key, Buffer.from(x.signature.value, "base64"));
    assert.ok(ok(r));
    // JSON round-trip (what the browser and verify script see) still verifies.
    assert.ok(ok(JSON.parse(JSON.stringify(r))));
    assert.ok(!ok({ ...r, isolation: { ...r.isolation, blockedAttempts: ["forged"], destroyed: false } }));
    assert.ok(!ok({ ...r, limits: { ...r.limits, memoryMb: 4096 } }));
    assert.ok(!ok({ ...r, stdout: r.stdout + "edited" }));
  });
  it("clamps egress to the server allowlist whatever the caller asks", async () => {
    const r = await runInSandbox({ taskId: "t", stepId: "s", attempt: 1, request: { kind: "browser", browser: { action: "navigate", url: "https://evil.example.org/" } }, egressAllowlist: ["evil.example.org"] });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.isolation.blockedAttempts.length > 0);
    assert.ok(!r.isolation.networkPolicy.includes("evil.example.org"));
  });
  it("caps concurrent sandboxes; ad-hoc callers get SandboxBusy", async () => {
    process.env.SANDBOX_MAX_CONCURRENT = "1";
    try {
      const first = code("print(1)");
      await assert.rejects(code("print(2)", { failFast: true }), SandboxBusy);
      await first;
      await code("print(3)", { failFast: true }); // slot released after destroy
    } finally {
      delete process.env.SANDBOX_MAX_CONCURRENT;
    }
  });
  it("containment verdict comes from evidence", async () => {
    const probe = await code("import os\nos.system('docker ps')");
    assert.equal(containmentVerdict(probe, true).level, probe.isolation.blockedAttempts.length ? "contained" : "breach");
    const plain = await code("print(1)");
    assert.equal(containmentVerdict(plain, true).level, "breach", "a probe with nothing blocked is a breach");
    assert.equal(containmentVerdict({ ...plain, isolation: { ...plain.isolation, destroyed: false } }, false).level, "unverified");
    assert.equal(containmentVerdict({ ...plain, isolation: { ...plain.isolation, hostTouched: true } }, false).level, "breach");
  });
});

describe("rateLimit", () => {
  it("allows N per minute per key, then asks to wait", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) assert.equal(rateLimit("k", 3, t), 0);
    assert.ok(rateLimit("k", 3, t + 10) > 0);
    assert.equal(rateLimit("k", 3, t + 60_000), 0);
    assert.equal(rateLimit("other", 3, t), 0);
  });
});
