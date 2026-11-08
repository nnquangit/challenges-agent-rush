// MockSandbox — simulates an isolated container. It NEVER runs user code on the
// host: code is pattern-matched against fixtures and a tiny print() emulator,
// browser actions render canned pages. Durations use a mock clock.

import { parseCsv } from "../csv";
import { newId, now } from "../ids";
import type { Artifact, BrowserSpec, ChartData, IsolationReport, ResourceLimits, TableData } from "../types";
import { evalPythonInt } from "./py-arith";
import { fixtureFor, isForbiddenTarget, renderBlockedScreenshot, renderScreenshot } from "./fixtures";
import type { CreateOptions, ExecRequest, ExecResult, SandboxProvider, SandboxSession } from "./provider";

const BASE_MEMORY_MB = 24;
/** First line of every non-empty stderr from MockSandbox. */
export const SIMULATED_STDERR_HEADER = "[mock] simulated stderr — written by MockSandbox; no container, kernel, cgroup or seccomp produced it";
/** Real delay is capped so the UI stays snappy; the receipt reports simulated time. */
const MAX_REAL_DELAY_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SimOutput {
  stdout: string[];
  stderr: string[];
  exitCode: number;
  simMs: number;
  peakMemoryMb: number;
  killedBy?: "timeout" | "memory";
  blocked: string[];
  artifacts: Omit<Artifact, "id">[];
}

const blank = (): SimOutput => ({ stdout: [], stderr: [], exitCode: 0, simMs: 120, peakMemoryMb: BASE_MEMORY_MB, blocked: [], artifacts: [] });

// ---------- Pattern A: code ----------

/** Size of an allocation expression such as 10**9 or 2 * 1024**3, as a JS number (exact evaluator, no host eval). */
function evalSize(expr: string): number | null {
  const v = evalPythonInt(expr);
  return v === null ? null : Number(v);
}

/** Estimate bytes allocated by obvious big allocations: bytearray(10**9), [0] * 10**8, "x" * 10**9. */
function estimateAllocMb(code: string): number {
  let max = 0;
  const probes: [RegExp, number][] = [
    [/bytearray\(([^)]*)\)/g, 1],
    [/\]\s*\*\s*([\d\s*()]+)/g, 8],
    [/["']\s*\*\s*([\d\s*()]+)/g, 1],
  ];
  for (const [re, bytesPer] of probes)
    for (const m of code.matchAll(re)) {
      const n = evalSize(m[1]);
      if (n) max = Math.max(max, (n * bytesPer) / (1024 * 1024));
    }
  return max;
}

function hasUnboundedLoop(code: string): boolean {
  return /while\s+(True|1)\s*:/.test(code) && !/\bbreak\b/.test(code);
}

const FAKE_PASSWD = "root:x:0:0:root:/root:/sbin/nologin\nsandbox:x:1000:1000::/sandbox:/bin/sh";
const HOST_PATHS = /^(\/host|\/var\/run\/docker\.sock|\/proc\/1\/root|\/root|\/Users|\/home\/(?!sandbox))/;

interface Ctx {
  env: Record<string, string>;
  files: Record<string, string>;
  limits: ResourceLimits;
}

function readFile(path: string, ctx: Ctx, out: SimOutput): string | null {
  const name = path.replace(/^\/sandbox\/input\//, "");
  if (path.startsWith("/sandbox/input/") && name in ctx.files) return ctx.files[name];
  if (path === "/etc/passwd") return FAKE_PASSWD;
  if (path === "/etc/hostname") return "proofbox-sbx";
  if (HOST_PATHS.test(path)) {
    out.blocked.push(`fs read ${path}`);
    out.stderr.push(`PermissionError: [Errno 13] Permission denied: '${path}' (host filesystem is not mounted)`);
    return null;
  }
  out.stderr.push(`FileNotFoundError: [Errno 2] No such file or directory: '${path}'`);
  return null;
}

/** Evaluate the argument of a print() call, conservatively. */
function evalPrintArg(arg: string, ctx: Ctx, out: SimOutput): string | null {
  const a = arg.trim();
  const str = a.match(/^[fr]?(["'])(.*)\1$/);
  if (str) return str[2].replace(/\\n/g, "\n");
  const env = a.match(/^os\.(?:environ\.get|getenv)\(\s*["']([^"']+)["']/) ?? a.match(/^os\.environ\[\s*["']([^"']+)["']\s*\]/);
  if (env) return ctx.env[env[1]] ?? "None";
  if (/^(dict\()?os\.environ\)?$/.test(a)) return JSON.stringify(ctx.env);
  const open = a.match(/^open\(\s*["']([^"']+)["'][^)]*\)\.read\(\)/);
  if (open) return readFile(open[1], ctx, out);
  // Exact Python integer arithmetic only; floats, "/" and anything else are not guessed.
  const n = evalPythonInt(a);
  if (n !== null) return n.toString();
  return `<mock: not evaluated: ${a.slice(0, 60)}>`;
}

function simulateGeneric(code: string, ctx: Ctx, out: SimOutput) {
  const handled = /\btry\s*:/.test(code);
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const pr = line.match(/^print\((.*)\)\s*$/);
    if (pr) {
      const v = evalPrintArg(pr[1], ctx, out);
      if (v !== null) out.stdout.push(v);
      continue;
    }
    const net = line.match(/(requests\.(?:get|post)|urllib\.request\.urlopen|socket\.create_connection|httpx\.(?:get|post))\(\s*\(?["']?([^"',)]+)/);
    if (net) {
      out.blocked.push(`network ${net[2]}`);
      out.stderr.push(`ConnectionRefusedError: egress to ${net[2]} denied by sandbox network policy (deny-all)`);
      if (!handled) {
        out.exitCode = 1;
        return;
      }
      continue;
    }
    const sh = line.match(/(?:os\.system|subprocess\.(?:run|call|check_output|Popen))\(\s*\[?["']([^"']+)/);
    if (sh) {
      const cmd = sh[1];
      if (/docker|nsenter|mount|chroot|sudo/.test(cmd)) {
        out.blocked.push(`exec ${cmd}`);
        out.stderr.push(`PermissionError: '${cmd.split(" ")[0]}' not permitted (no capabilities, seccomp profile)`);
      } else {
        out.stderr.push(`[sandbox] '${cmd}' ran against the ephemeral overlay fs only`);
      }
    }
  }
}

function simulatePrimes(code: string, out: SimOutput) {
  const N = Number(code.match(/\bN\s*=\s*(\d+)/)?.[1] ?? 100);
  const sieve = new Uint8Array(N).fill(1);
  const primes: number[] = [];
  for (let i = 2; i < N; i++) {
    if (!sieve[i]) continue;
    primes.push(i);
    for (let j = i * i; j < N; j += i) sieve[j] = 0;
  }
  const total = primes.reduce((a, b) => a + b, 0);
  out.stdout.push(`primes below ${N}: ${primes.length}`, `sum: ${total}`, `largest: ${primes.at(-1) ?? "-"}`);
  out.simMs = 40 + Math.round(N / 2000);
  out.peakMemoryMb = BASE_MEMORY_MB + Math.round(N / 1e6);
  const claim = code.match(/assert\s+total\s*==\s*(\d+)/);
  if (claim && Number(claim[1]) !== total) {
    out.stderr.push(
      "Traceback (most recent call last):",
      '  File "/sandbox/main.py", line 12, in <module>',
      `AssertionError: claimed ${claim[1]}, computed ${total}`,
    );
    out.exitCode = 1;
    return;
  }
  if (claim) out.stdout.push(`assert total == ${total} ✓ proven`);
  out.artifacts.push({
    kind: "json",
    name: "result.json",
    mime: "application/json",
    content: JSON.stringify({ N, count: primes.length, sum: total, first: primes.slice(0, 10), largest: primes.at(-1) }, null, 2),
  });
}

function simulateCsv(code: string, ctx: Ctx, out: SimOutput) {
  const path = code.match(/read_csv\(\s*["']([^"']+)["']/)?.[1] ?? "/sandbox/input/data.csv";
  const text = readFile(path, ctx, out);
  if (text === null) {
    out.exitCode = 1;
    return;
  }
  const { columns, rows } = parseCsv(text);
  const groupBy = code.match(/GROUP_BY\s*=\s*["']([^"']+)["']/)?.[1] ?? columns[0];
  const value = code.match(/VALUE\s*=\s*["']([^"']+)["']/)?.[1] ?? columns.at(-1)!;
  for (const col of [groupBy, value]) {
    if (!columns.includes(col)) {
      out.stderr.push(
        "Traceback (most recent call last):",
        '  File "/sandbox/analyze.py", line 9, in <module>',
        `    grouped = df.groupby(GROUP_BY)[VALUE].agg(["sum", "count", "mean"])`,
        `KeyError: '${col}' (columns: ${columns.join(", ")})`,
      );
      out.exitCode = 1;
      out.simMs = 310;
      return;
    }
  }
  const gi = columns.indexOf(groupBy);
  const vi = columns.indexOf(value);
  const groups = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const v = Number(r[vi]);
    if (!Number.isFinite(v)) continue;
    const g = groups.get(r[gi]) ?? { sum: 0, count: 0 };
    g.sum += v;
    g.count++;
    groups.set(r[gi], g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const round = (n: number) => Math.round(n * 100) / 100;
  const table: TableData = {
    columns: [groupBy, `sum(${value})`, "count", `mean(${value})`],
    rows: sorted.map(([k, g]) => [k, round(g.sum), g.count, round(g.sum / g.count)]),
  };
  const total = sorted.reduce((a, [, g]) => a + g.sum, 0);
  out.stdout.push(
    `loaded ${rows.length} rows × ${columns.length} columns from ${path}`,
    `grouped by ${groupBy}, aggregated ${value}`,
    ...table.rows.map((r) => `  ${String(r[0]).padEnd(12)} sum=${r[1]}  n=${r[2]}  mean=${r[3]}`),
    `total ${value}: ${round(total)}`,
    sorted[0] ? `top ${groupBy}: ${sorted[0][0]} (${round((sorted[0][1].sum / total) * 100)}% of total)` : "no numeric rows",
  );
  out.simMs = 420 + rows.length;
  out.peakMemoryMb = BASE_MEMORY_MB + 48 + Math.round(text.length / 1e5);
  const chart: ChartData = { label: `sum(${value}) by ${groupBy}`, points: sorted.map(([x, g]) => ({ x, y: round(g.sum) })) };
  out.artifacts.push(
    { kind: "table", name: "summary.csv", mime: "text/csv", content: [table.columns, ...table.rows].map((r) => r.join(",")).join("\n"), data: table },
    { kind: "chart", name: "chart.json", mime: "application/json", content: JSON.stringify(chart), data: chart },
  );
}

function simulateCode(code: string, ctx: Ctx): SimOutput {
  const out = blank();
  const allocMb = estimateAllocMb(code);
  if (allocMb > ctx.limits.memoryMb) {
    out.peakMemoryMb = ctx.limits.memoryMb;
    out.killedBy = "memory";
    out.exitCode = 137;
    out.simMs = 260;
    out.stderr.push(`MemoryError: allocation of ~${Math.round(allocMb)} MiB exceeds cgroup cap ${ctx.limits.memoryMb} MiB`, "[sandbox] OOM-killed (exit 137)");
    return out;
  }
  if (hasUnboundedLoop(code)) {
    out.killedBy = "timeout";
    out.exitCode = 124;
    out.simMs = ctx.limits.timeoutMs;
    out.peakMemoryMb = BASE_MEMORY_MB + 4;
    out.stderr.push(`[sandbox] wall-clock cap ${ctx.limits.timeoutMs} ms reached — process group killed (exit 124)`);
    return out;
  }
  out.peakMemoryMb = Math.max(BASE_MEMORY_MB, Math.round(allocMb) + BASE_MEMORY_MB);
  const fixture = code.match(/#\s*proofbox:fixture=([\w-]+)/)?.[1];
  if (fixture === "prove-primes") simulatePrimes(code, out);
  else if (fixture === "csv-analyze") simulateCsv(code, ctx, out);
  else simulateGeneric(code, ctx, out);
  return out;
}

// ---------- Pattern B: browser ----------

function simulateBrowser(spec: BrowserSpec, allow: string[]): SimOutput {
  const out = blank();
  out.peakMemoryMb = 180; // headless chromium baseline
  out.simMs = 850;
  let url: URL;
  try {
    url = new URL(spec.url ?? "about:blank");
  } catch {
    out.exitCode = 2;
    out.stderr.push(`invalid url: ${spec.url}`);
    return out;
  }
  const netlog: string[] = [];
  const forbidden = isForbiddenTarget(url);
  const allowed = allow.includes(url.hostname);
  if (forbidden || !allowed) {
    const reason = forbidden ?? `host ${url.hostname} not in egress allowlist [${allow.join(", ") || "none"}]`;
    out.blocked.push(`navigate ${url.href}`);
    out.exitCode = 1;
    out.stderr.push(`page.goto: net::ERR_BLOCKED_BY_SANDBOX_POLICY — ${reason}`);
    out.stdout.push("navigation stayed in sandbox: request dropped at egress proxy");
    netlog.push(`DROP GET ${url.href} — ${reason}`);
    out.artifacts.push(
      { kind: "image", name: "blocked.svg", mime: "image/svg+xml", content: renderBlockedScreenshot(url.href, reason) },
      { kind: "log", name: "network.log", mime: "text/plain", content: netlog.join("\n") },
    );
    return out;
  }
  const page = fixtureFor(url.hostname);
  netlog.push(`GET ${url.href} → 200 (served by sandbox fixture proxy, no public egress)`);
  out.stdout.push(`page.goto(${url.href}) → "${page.title}"`);
  const shot = (s: Partial<Parameters<typeof renderScreenshot>[0]>, name: string) =>
    out.artifacts.push({ kind: "image", name, mime: "image/svg+xml", content: renderScreenshot({ url: url.href, page, ...s }) });

  switch (spec.action) {
    case "navigate":
      shot({}, "page.svg");
      break;
    case "screenshot": {
      const want = (spec.expect ?? "").toLowerCase();
      const hit = page.evidence.find((e) => want.includes(e.label.toLowerCase())) ?? page.evidence[0];
      shot({ highlight: hit?.label }, "evidence.svg");
      out.stdout.push(`page.screenshot(full_page=True) → evidence.svg`, hit ? `evidence: ${hit.label} = ${hit.text}` : "no evidence block found");
      out.artifacts.push({ kind: "json", name: "dom-evidence.json", mime: "application/json", content: JSON.stringify({ url: url.href, evidence: page.evidence, highlighted: hit ?? null }, null, 2) });
      break;
    }
    case "fill": {
      const fields = spec.fields ?? (spec.selector ? { [spec.selector]: spec.value ?? "" } : {});
      const known = new Set(page.form?.map((f) => f.selector));
      for (const [sel, v] of Object.entries(fields)) {
        if (!known.has(sel)) {
          out.stderr.push(`page.fill: selector ${sel} not found`);
          out.exitCode = 1;
        } else out.stdout.push(`page.fill("${sel}", ${JSON.stringify(v)})`);
      }
      shot({ filled: fields, banner: { tone: "warn", text: "Draft filled — NOT submitted (awaiting human confirm)" } }, "form-draft.svg");
      break;
    }
    case "submit":
      netlog.push(`POST ${url.origin}/contact → 202 (captured by sandbox fixture; nothing sent to the real site)`);
      out.stdout.push(`page.click("button[type=submit]") → 202 captured by fixture`);
      shot({ filled: spec.fields, banner: { tone: "ok", text: "Submitted to sandbox fixture — no external request was made" } }, "submitted.svg");
      break;
  }
  out.artifacts.push({ kind: "log", name: "network.log", mime: "text/plain", content: netlog.join("\n") });
  return out;
}

// ---------- Provider ----------

class MockSession implements SandboxSession {
  readonly id = newId("sbx");
  readonly provider = "mock";
  private collected: Artifact[] = [];
  private blocked: string[] = [];
  private destroyedAt?: string;

  constructor(
    readonly taskId: string,
    private opts: CreateOptions,
  ) {}

  async exec(req: ExecRequest): Promise<ExecResult> {
    if (this.destroyedAt) throw new Error(`sandbox ${this.id} already destroyed`);
    const ctx: Ctx = { env: this.opts.env, files: this.opts.files ?? {}, limits: this.opts.limits };
    const sim = req.kind === "code" ? simulateCode(req.code, ctx) : simulateBrowser(req.browser, this.opts.egressAllowlist ?? []);
    await sleep(Math.min(sim.simMs, MAX_REAL_DELAY_MS));
    this.blocked.push(...sim.blocked);
    this.collected.push(...sim.artifacts.map((a) => ({ ...a, id: newId("art") })));
    return {
      exitCode: sim.exitCode,
      stdout: sim.stdout.join("\n"),
      // Every stderr line below was written by this mock, not by a kernel, cgroup or
      // seccomp filter. Say so inside the signed receipt, so a cropped stderr box
      // or a copied receipt cannot pass it off as real enforcement.
      stderr: sim.stderr.length ? [SIMULATED_STDERR_HEADER, ...sim.stderr].join("\n") : "",
      durationMs: sim.simMs,
      peakMemoryMb: sim.peakMemoryMb,
      killedBy: sim.killedBy,
      blockedAttempts: sim.blocked,
    };
  }

  async artifacts(): Promise<Artifact[]> {
    return [...this.collected];
  }

  isolation(): IsolationReport {
    const allow = this.opts.egressAllowlist ?? [];
    return {
      provider: "mock",
      simulated: true,
      hostTouched: false,
      networkPolicy: allow.length ? `egress allowlist via proxy: ${allow.join(", ")}` : "deny-all egress",
      pidNamespace: "mock:isolated (runner is pid 1)",
      fsRoot: `/sandbox (ephemeral overlay, inputs read-only)`,
      user: "sandbox uid=1000, no capabilities",
      blockedAttempts: [...this.blocked],
      destroyed: Boolean(this.destroyedAt),
      destroyedAt: this.destroyedAt,
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyedAt) return;
    this.collected = [];
    this.destroyedAt = now();
  }
}

export class MockSandbox implements SandboxProvider {
  readonly name = "mock";
  async create(taskId: string, opts: CreateOptions): Promise<SandboxSession> {
    await sleep(120);
    return new MockSession(taskId, opts);
  }
}
