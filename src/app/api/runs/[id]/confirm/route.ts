import { requireSession } from "@/lib/access";
import { bad, json, readJson } from "@/lib/http";
import { confirmStep, RunRefused } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

/**
 * POST /api/runs/:id/confirm { stepId, approve } — human gate for final actions.
 * Only the run's owner (session principal) can decide; anyone else gets 404.
 * One decision per gate: a second one (replay, flip, concurrent duplicate) is 409.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = requireSession(req);
  if (who instanceof Response) return who;
  const { id } = await params;
  const body = await readJson<{ stepId?: unknown; approve?: unknown }>(req);
  if (typeof body?.stepId !== "string" || typeof body.approve !== "boolean") return bad("stepId (string) and approve (boolean) are required");
  try {
    return json({ run: confirmStep(id, body.stepId, body.approve, who.principal) });
  } catch (e) {
    if (e instanceof RunRefused) return bad(e.message, e.status);
    throw e;
  }
}
