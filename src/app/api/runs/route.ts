import { requireSession } from "@/lib/access";
import { runQuotas } from "@/lib/config";
import { bad, json, readJson } from "@/lib/http";
import { RunRefused, startRun } from "@/lib/orchestrator";
import { rateLimit } from "@/lib/rate-limit";
import { ownPlan, runsOf } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/runs { planId } → 202 { run }. Only the caller's own plans, made by
 * the planner and stored server-side, can be dispatched — once each. Clients
 * cannot submit steps. 404 for an unknown or foreign plan, 409 for a plan that
 * already ran, 429 when the caller or the server has too many active runs.
 */
export async function POST(req: Request) {
  const who = requireSession(req);
  if (who instanceof Response) return who;
  const wait = rateLimit(`runs:${who.principal}`, runQuotas().runsPerMinute);
  if (wait) return bad(`rate limited — retry in ${wait}s`, 429);
  const body = await readJson<{ planId?: unknown }>(req);
  const plan = ownPlan(body?.planId, who.principal);
  if (!plan) return bad("unknown planId", 404);
  try {
    return json({ run: startRun(plan, who.principal) }, 202);
  } catch (e) {
    if (e instanceof RunRefused) return bad(e.message, e.status);
    throw e;
  }
}

/** GET /api/runs → the caller's own recent runs (never anyone else's). */
export function GET(req: Request) {
  const who = requireSession(req);
  if (who instanceof Response) return who;
  const runs = runsOf(who.principal)
    .reverse()
    .map((r) => ({ id: r.id, title: r.plan.title, intent: r.plan.intent, status: r.status, createdAt: r.createdAt, steps: r.steps.length }));
  return json({ runs });
}
