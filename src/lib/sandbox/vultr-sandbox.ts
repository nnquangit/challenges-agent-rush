// VultrSandbox — STUB. Interface only; no network code in the mock-first phase.
//
// Intended implementation (after Vultr accounts are approved):
//   create()  → POST {VULTR_SANDBOX_HOST}/sandboxes on a Vultr VM running a small
//               runner daemon that starts a Docker container (gVisor runtime,
//               --network none or egress proxy, --memory, --pids-limit, read-only
//               rootfs + tmpfs /sandbox, non-root user, no capabilities).
//   exec()    → POST /sandboxes/:id/exec, stream stdout/stderr, enforce timeout.
//   artifacts → GET /sandboxes/:id/artifacts (files written to /sandbox/out).
//   destroy() → DELETE /sandboxes/:id (container removed, overlay discarded).

import { isMock } from "../config";
import type { CreateOptions, SandboxProvider, SandboxSession } from "./provider";

export class NotImplementedInMockPhase extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (mock-first phase). Set MOCK=1 to use MockSandbox.`);
    this.name = "NotImplementedInMockPhase";
  }
}

export class VultrSandbox implements SandboxProvider {
  readonly name = "vultr";

  constructor(
    private readonly config = {
      host: process.env.VULTR_SANDBOX_HOST ?? "",
      tokenPresent: Boolean(process.env.VULTR_SANDBOX_TOKEN),
    },
  ) {}

  async create(taskId: string, opts: CreateOptions): Promise<SandboxSession> {
    void taskId;
    void opts;
    if (isMock()) throw new Error("VultrSandbox must not be used while MOCK=1");
    if (!this.config.host) throw new Error("VULTR_SANDBOX_HOST is not set");
    throw new NotImplementedInMockPhase("VultrSandbox.create");
  }
}
