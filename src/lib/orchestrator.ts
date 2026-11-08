// Control plane: walks a plan step by step, dispatching each step into its own
// fresh sandbox, retrying code failures once via the LLM, and pausing before
// any step marked requiresConfirm until a human approves or denies it.

import { isMock, runQuotas, sandboxQuotas } from "./config";
import { newId, now } from "./ids";
import { getLlm } from "./llm";
import { requestForStep, runInSandbox } from "./sandbox";
import { isLive, ownRun, runsOf, saveRun, store } from "./store";
import type { Plan, PlanStep, Run, StepRun, TimelineEvent } from "./types";

const MAX_ATTEMPTS = 2;

function log(run: Run, type: TimelineEvent["type"], message: string, stepId?: string) {
  run.events.push({ at: now(), type, message, stepId });
}

/** A run that may not start or a decision that may not be taken, with the HTTP status to answer. */
export class RunRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Start a run of the caller's plan. Plans are single-use (a plan is a one-time
 * capability issued by the planner), and admission is bounded per principal and
 * globally, so one caller cannot fill the sandbox queue.
 */
export function startRun(plan: Plan, owner: string): Run {
  if (plan.owner !== owner) throw new RunRefused("unknown planId", 404);
  if (plan.runId) throw new RunRefused(`plan already dispatched as ${plan.runId} — plans are single-use; ask the planner again`, 409);
  const q = runQuotas();
  const mine = runsOf(owner).filter(isLive).length;
  if (mine >= q.activePerPrincipal) throw new RunRefused(`you already have ${mine} active run(s) (limit ${q.activePerPrincipal}) — wait for one to finish`, 429);
  const running = [...store.runs.values()].filter((r) => r.status === "running").length;
  if (running >= q.activeMax) throw new RunRefused(`server is busy (${running} runs in progress) — retry shortly`, 429);
  const run: Run = {
    id: newId("run"),
    plan,
    status: "running",
    steps: plan.steps.map((s) => ({ stepId: s.id, status: "pending", attempts: [], code: s.code })),
    events: [],
    createdAt: now(),
    mode: isMock() ? "mock" : "vultr",
    owner,
  };
  plan.runId = run.id;
  log(run, "run.created", `${plan.steps.length} step(s) planned by ${plan.planner}`);
  saveRun(run);
  void advance(run.id);
  return run;
}

/**
 * Human decision on a paused step. Only the run's owner can decide (anyone else
 * gets the same 404 as for a missing run). A decision is taken once: replays,
 * flips and concurrent duplicates get 409 (this function is synchronous, so two
 * requests cannot both see "awaiting_confirm").
 */
export function confirmStep(runId: string, stepId: string, approve: boolean, principal: string): Run {
  const run = ownRun(runId, principal);
  if (!run) throw new RunRefused("run not found", 404);
  const sr = run.steps.find((s) => s.stepId === stepId);
  if (!sr || sr.status !== "awaiting_confirm") throw new RunRefused("step is not awaiting confirmation", 409);
  sr.confirmation = { approved: approve, at: now() };
  sr.status = "pending";
  run.status = "running";
  log(run, approve ? "confirm.approved" : "confirm.denied", approve ? "Human approved the final action" : "Human denied the final action — it will not run", stepId);
  void advance(run.id);
  return run;
}

/** An unanswered gate is denied after CONFIRM_TTL_MS, so paused runs do not pile up. */
function expireGateLater(runId: string, stepId: string) {
  const t = setTimeout(() => {
    const run = store.runs.get(runId);
    const sr = run?.steps.find((s) => s.stepId === stepId);
    if (!run || !sr || sr.status !== "awaiting_confirm") return;
    sr.confirmation = { approved: false, at: now(), expired: true };
    sr.status = "pending";
    run.status = "running";
    log(run, "confirm.expired", "No human decision in time — treated as denied; nothing will be submitted", stepId);
    void advance(run.id);
  }, runQuotas().confirmTtlMs);
  t.unref?.();
}

async function advance(runId: string) {
  const run = store.runs.get(runId);
  if (!run || store.locks.has(runId)) return;
  store.locks.add(runId);
  try {
    for (const sr of run.steps) {
      if (sr.status !== "pending") continue;
      const step = run.plan.steps.find((s) => s.id === sr.stepId)!;
      // Policy, not planner: a browser submit always needs a human, even if a (real) LLM forgot the flag.
      const needsConfirm = step.requiresConfirm || (step.kind === "browser" && step.browser?.action === "submit");
      if (needsConfirm && !sr.confirmation) {
        sr.status = "awaiting_confirm";
        run.status = "awaiting_confirm";
        log(run, "confirm.requested", `"${step.title}" has effects beyond read-only browsing — waiting for a human yes/no`, step.id);
        expireGateLater(run.id, sr.stepId);
        return;
      }
      if (sr.confirmation && !sr.confirmation.approved) {
        sr.status = "skipped";
        sr.explanation = sr.confirmation.expired
          ? "Skipped: nobody approved this action in time, so it was denied. Nothing was submitted."
          : "Skipped: the human reviewer denied this action. Nothing was submitted.";
        log(run, "step.skipped", `${step.title} skipped`, step.id);
        continue;
      }
      sr.status = "running";
      await executeStep(run, step, sr);
    }
    run.status = run.steps.some((s) => s.status === "failed") ? "failed" : "succeeded";
    run.finishedAt = now();
    log(run, "run.finished", `Run ${run.status}: ${run.steps.filter((s) => s.status === "succeeded").length}/${run.steps.length} steps succeeded`);
  } catch (e) {
    for (const sr of run.steps) if (sr.status === "running") sr.status = "failed";
    run.status = "failed";
    run.finishedAt = now();
    log(run, "run.finished", `Run aborted: ${(e as Error).message}`);
  } finally {
    store.locks.delete(runId);
  }
}

async function executeStep(run: Run, step: PlanStep, sr: StepRun) {
  const llm = getLlm();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const receipt = await runInSandbox({
      taskId: run.id,
      stepId: step.id,
      attempt,
      request: requestForStep(step, sr.code),
      limits: step.limits,
      files: run.plan.files,
      egressAllowlist: step.kind === "browser" ? run.plan.egressAllowlist : [],
      principal: run.owner,
      maxWaitMs: sandboxQuotas().runWaitMs,
      onEvent: (type, message) => log(run, type, message, step.id),
    });
    sr.attempts.push(receipt);

    if (step.probe) {
      const held = receipt.isolation.blockedAttempts.length > 0 || Boolean(receipt.killedBy);
      sr.status = held ? "succeeded" : "failed";
      log(run, "containment", held ? `Containment held: ${receipt.killedBy ? `killed by ${receipt.killedBy} cap` : receipt.isolation.blockedAttempts.join("; ")}` : "Probe was not blocked!", step.id);
      break;
    }
    if (receipt.exitCode === 0) {
      sr.status = "succeeded";
      break;
    }
    const repair = step.kind === "code" && attempt < MAX_ATTEMPTS ? await llm.repair(step, sr.code ?? "", receipt, run.plan.files ?? {}) : null;
    if (!repair) {
      sr.status = "failed";
      break;
    }
    sr.code = repair.code;
    log(run, "step.retry", `Attempt ${attempt} failed (exit ${receipt.exitCode}). ${repair.note}`, step.id);
  }

  const last = sr.attempts.at(-1)!;
  if (step.kind === "browser") {
    sr.verdict = await llm.verify(step, last);
    log(run, "llm.verify", sr.verdict.notes, step.id);
    if (!sr.verdict.ok && !step.probe) sr.status = "failed";
  }
  sr.explanation = await llm.explain(step, last);
  log(run, "llm.explain", sr.explanation, step.id);
  log(run, sr.status === "succeeded" ? "step.succeeded" : "step.failed", `${step.title}: ${sr.status}`, step.id);
}
