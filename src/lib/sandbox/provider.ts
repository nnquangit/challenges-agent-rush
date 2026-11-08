import type { Artifact, BrowserSpec, IsolationReport, ResourceLimits } from "../types";

export type ExecRequest =
  | { kind: "code"; language: "python"; code: string }
  | { kind: "browser"; browser: BrowserSpec };

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  peakMemoryMb: number;
  killedBy?: "timeout" | "memory";
  blockedAttempts: string[];
}

export interface CreateOptions {
  limits: ResourceLimits;
  /** Env as the sandbox will see it — already redacted by the caller. */
  env: Record<string, string>;
  /** Files mounted read-only at /sandbox/input. */
  files?: Record<string, string>;
  /** Hostnames the sandbox may reach (browser pattern). Empty = deny-all egress. */
  egressAllowlist?: string[];
}

/** One isolated environment, used for exactly one task and then destroyed. */
export interface SandboxSession {
  readonly id: string;
  readonly provider: string;
  exec(req: ExecRequest): Promise<ExecResult>;
  artifacts(): Promise<Artifact[]>;
  isolation(): IsolationReport;
  /** Must be idempotent: lifecycle code calls it from `finally`. */
  destroy(): Promise<void>;
}

/**
 * Contract every sandbox backend implements (MockSandbox today, VultrSandbox
 * later). The UI and API never import a concrete provider.
 */
export interface SandboxProvider {
  readonly name: string;
  create(taskId: string, opts: CreateOptions): Promise<SandboxSession>;
}
