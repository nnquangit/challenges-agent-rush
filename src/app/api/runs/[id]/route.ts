import { requireSession } from "@/lib/access";
import { bad, json } from "@/lib/http";
import { ownRun } from "@/lib/store";

export const dynamic = "force-dynamic";

/** GET /api/runs/:id → the caller's run with per-step receipts, timeline and isolation reports. 404 for anyone else's. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const who = requireSession(req);
  if (who instanceof Response) return who;
  const { id } = await params;
  const run = ownRun(id, who.principal);
  return run ? json({ run }) : bad("run not found", 404);
}
