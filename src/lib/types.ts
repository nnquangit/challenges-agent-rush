// Shared domain types for ProofBox. The UI only depends on these shapes, so the
// mock providers can be swapped for Vultr providers without touching the UI.

export type Intent = "code" | "csv" | "browser";

export interface ResourceLimits {
  /** Wall-clock cap per exec, in milliseconds. */
  timeoutMs: number;
  /** Memory cap per sandbox, in MiB. */
  memoryMb: number;
}

export type BrowserAction = "navigate" | "screenshot" | "fill" | "submit";

export interface BrowserSpec {
  action: BrowserAction;
  url?: string;
  selector?: string;
  value?: string;
  /** For action "fill": selector → value. */
  fields?: Record<string, string>;
  /** Natural-language evidence the vision check should look for. */
  expect?: string;
}

export type StepKind = "code" | "browser";

export interface PlanStep {
  id: string;
  kind: StepKind;
  title: string;
  description: string;
  /** Pattern A: code to run inside the sandbox. */
  language?: "python";
  code?: string;
  /** Pattern B: browser action to run inside the sandbox. */
  browser?: BrowserSpec;
  /** Steps with side effects outside the sandbox need a human yes/no first. */
  requiresConfirm?: boolean;
  /** Marks a step that deliberately tries to escape, to prove containment. */
  probe?: boolean;
  /** "policy" = inserted by the control plane (src/lib/policy.ts), not by the planner. */
  addedBy?: "policy";
  limits?: Partial<ResourceLimits>;
}

export interface Plan {
  id: string;
  intent: Intent;
  title: string;
  summary: string;
  /** Files mounted read-only into every sandbox of the run (e.g. data.csv). */
  files?: Record<string, string>;
  /** Hosts browser steps may reach (via the sandbox egress proxy). */
  egressAllowlist?: string[];
  steps: PlanStep[];
  createdAt: string;
  planner: string;
  /** What the control-plane policy changed in the planner's output. */
  policy?: PolicyReport;
  /** Session principal that asked for the plan (set by the server; src/lib/access.ts). */
  owner?: string;
  /** Plans are single-use: the run this plan was dispatched as. */
  runId?: string;
}

export interface PolicyReport {
  /** Hosts the user named that the server egress allowlist refused. */
  egressRefused: string[];
  probesAdded: string[];
  confirmForced: string[];
  probeFlagsCleared: string[];
}

export type ArtifactKind = "text" | "table" | "chart" | "image" | "log" | "json";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  name: string;
  mime: string;
  /** Text content, or a data: URL for images. */
  content: string;
  /** Structured payload for tables/charts. */
  data?: unknown;
}

export interface TableData {
  columns: string[];
  rows: (string | number)[][];
}

export interface ChartData {
  label: string;
  points: { x: string; y: number }[];
}

export interface IsolationReport {
  provider: string;
  simulated: boolean;
  /** Evidence-based, not a constant: providers must report what they observed. */
  hostTouched: boolean;
  networkPolicy: string;
  pidNamespace: string;
  fsRoot: string;
  user: string;
  blockedAttempts: string[];
  destroyed: boolean;
  destroyedAt?: string;
}

export interface Receipt {
  sandboxId: string;
  provider: string;
  stepId: string;
  attempt: number;
  command: string;
  /** Exact input executed: source code, or the browser action as JSON. Covered by sha256. */
  input: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: Artifact[];
  limits: ResourceLimits;
  killedBy?: "timeout" | "memory";
  peakMemoryMb: number;
  envInjected: Record<string, string>;
  redactions: number;
  isolation: IsolationReport;
  /** "simulated" = durationMs comes from the mock clock; startedAt/endedAt are wall time. */
  clock: "simulated" | "wall";
  /** When the receipt was sealed — after destroy(), so isolation.destroyed is covered. */
  sealedAt: string;
  /** hex SHA-256 of the canonical receipt (every field except sha256/signature; see receipt-canonical.ts). */
  sha256: string;
  /** Ed25519 over the same canonical payload. Public key: GET /api/receipts/public-key. */
  signature: { alg: "Ed25519"; keyId: string; value: string };
}

export type StepStatus = "pending" | "running" | "awaiting_confirm" | "succeeded" | "failed" | "skipped";

export interface StepRun {
  stepId: string;
  status: StepStatus;
  attempts: Receipt[];
  explanation?: string;
  verdict?: { ok: boolean; notes: string };
  confirmation?: { approved: boolean; at: string; expired?: boolean };
  /** Code actually run for the latest attempt (may differ after an LLM repair). */
  code?: string;
}

export type RunStatus = "running" | "awaiting_confirm" | "succeeded" | "failed";

export interface TimelineEvent {
  at: string;
  stepId?: string;
  type:
    | "run.created"
    | "sandbox.created"
    | "sandbox.exec"
    | "sandbox.destroyed"
    | "step.succeeded"
    | "step.failed"
    | "step.retry"
    | "step.skipped"
    | "confirm.requested"
    | "confirm.approved"
    | "confirm.denied"
    | "confirm.expired"
    | "llm.explain"
    | "llm.verify"
    | "containment"
    | "run.finished";
  message: string;
}

export interface Run {
  id: string;
  plan: Plan;
  status: RunStatus;
  steps: StepRun[];
  events: TimelineEvent[];
  createdAt: string;
  finishedAt?: string;
  mode: "mock" | "vultr";
  /** Session principal that owns the run; only it can read, list or confirm it. */
  owner: string;
}
