import { egressAllowlist, isMock, resolveLimits, sandboxQuotas } from "../config";
import { now } from "../ids";
import { sealReceipt } from "./signing";
import type { PlanStep, Receipt, ResourceLimits } from "../types";
import { MockSandbox } from "./mock-sandbox";
import type { ExecRequest, SandboxProvider, SandboxSession } from "./provider";
import { buildSandboxEnv, redactText } from "./redact";
import { SlotPool } from "./slots";
import { VultrSandbox } from "./vultr-sandbox";

export type { ExecRequest, SandboxProvider } from "./provider";

/** Fake, publicly known value — not a secret. Used only to demo redaction. */
export const MOCK_CANARY = "sk-proofbox-canary-not-a-real-key-0000";

export { SandboxBusy } from "./slots";

// Global cap on live sandboxes, shared fairly between principals (see slots.ts).
// Kept on globalThis so all route modules share one pool.
const g = globalThis as unknown as { __proofboxSlots?: SlotPool };
const slots = (g.__proofboxSlots ??= new SlotPool(() => sandboxQuotas()));
export const sandboxStats = () => slots.stats();

let provider: SandboxProvider | null = null;
export function getSandboxProvider(): SandboxProvider {
  provider ??= isMock() ? new MockSandbox() : new VultrSandbox();
  return provider;
}

export interface RunInSandboxInput {
  taskId: string;
  stepId: string;
  attempt: number;
  request: ExecRequest;
  limits?: Partial<ResourceLimits>;
  files?: Record<string, string>;
  egressAllowlist?: string[];
  /** Who the sandbox is for (session principal); slots are shared fairly between principals. */
  principal?: string;
  /** How long to wait for a slot before SandboxBusy. Default: wait (bounded by the queue limits). */
  maxWaitMs?: number;
  /** Shorthand for maxWaitMs 0: throw SandboxBusy at once when no slot is free. */
  failFast?: boolean;
  onEvent?: (type: "sandbox.created" | "sandbox.exec" | "sandbox.destroyed", message: string) => void;
}

/**
 * The only way code reaches a sandbox. Lifecycle is fixed:
 *   redact env → create → exec → collect artifacts → destroy (always, in finally)
 * and every output is scrubbed for secrets before it leaves.
 */
export async function runInSandbox(input: RunInSandboxInput): Promise<Receipt> {
  const sandbox = getSandboxProvider();
  const limits = resolveLimits(input.limits);
  // In mock mode the host also holds a fake canary key, so the demo can show a
  // secret that exists on the host but is never visible inside the sandbox.
  const hostEnv = isMock() ? { ...process.env, PROOFBOX_CANARY_API_KEY: MOCK_CANARY } : process.env;
  const { env, redactions: envRedactions } = buildSandboxEnv(hostEnv, { PROOFBOX_TASK: input.taskId });
  const command =
    input.request.kind === "code"
      ? `python3 /sandbox/main.py  # ${input.request.code.split("\n").length} lines`
      : `playwright ${input.request.browser.action} ${input.request.browser.url ?? ""}`.trim();

  const execInput = input.request.kind === "code" ? input.request.code : JSON.stringify(input.request.browser, null, 2);
  // Defense in depth: whatever the caller asks, egress never exceeds the server allowlist.
  const server = egressAllowlist();
  const egress = (input.egressAllowlist ?? []).map((h) => h.toLowerCase()).filter((h) => server.includes(h));
  const release = await slots.acquire(input.principal ?? "anonymous", input.failFast ? 0 : (input.maxWaitMs ?? Number.POSITIVE_INFINITY));
  const startedAt = now();
  let session: SandboxSession;
  try {
    session = await sandbox.create(input.taskId, { limits, env, files: input.files, egressAllowlist: egress });
  } catch (e) {
    release();
    throw e;
  }
  input.onEvent?.("sandbox.created", `${session.id} created (${limits.timeoutMs} ms, ${limits.memoryMb} MiB)`);
  let receipt: Omit<Receipt, "isolation" | "sha256" | "signature" | "sealedAt" | "clock">;
  try {
    const res = await session.exec(input.request);
    const rawArtifacts = await session.artifacts();
    input.onEvent?.("sandbox.exec", `${command} → exit ${res.exitCode}${res.killedBy ? ` (killed: ${res.killedBy})` : ""}`);

    const out = redactText(res.stdout, hostEnv);
    const err = redactText(res.stderr, hostEnv);
    let artifactRedactions = 0;
    const artifacts = rawArtifacts.map((a) => {
      if (a.kind === "image") return a;
      const r = redactText(a.content, hostEnv);
      artifactRedactions += r.count;
      return { ...a, content: r.text };
    });
    const endedAt = now();
    receipt = {
      sandboxId: session.id,
      provider: session.provider,
      stepId: input.stepId,
      attempt: input.attempt,
      command,
      input: execInput,
      startedAt,
      endedAt,
      durationMs: res.durationMs,
      exitCode: res.exitCode,
      stdout: out.text,
      stderr: err.text,
      artifacts,
      limits,
      killedBy: res.killedBy,
      peakMemoryMb: res.peakMemoryMb,
      envInjected: env,
      redactions: envRedactions + out.count + err.count + artifactRedactions,
    };
  } finally {
    try {
      await session.destroy();
      input.onEvent?.("sandbox.destroyed", `${session.id} destroyed — overlay discarded`);
    } finally {
      release();
    }
  }
  // Read after destroy(), so the receipt proves the environment is gone, then
  // hash + sign the whole thing (isolation, limits, env, timestamps included).
  const isolation = session.isolation();
  return sealReceipt({ ...receipt, isolation, clock: isolation.simulated ? "simulated" : "wall", sealedAt: now() });
}

export function requestForStep(step: PlanStep, code?: string): ExecRequest {
  if (step.kind === "browser") return { kind: "browser", browser: step.browser ?? { action: "navigate" } };
  return { kind: "code", language: "python", code: code ?? step.code ?? "" };
}
