import { requireSession } from "@/lib/access";
import { runQuotas } from "@/lib/config";
import { bad, json, readJson } from "@/lib/http";
import { getLlm } from "@/lib/llm";
import { enforcePolicy } from "@/lib/policy";
import { rateLimit } from "@/lib/rate-limit";
import { savePlan } from "@/lib/store";

export const dynamic = "force-dynamic";
const MAX_MESSAGE = 20_000;

/** POST /api/chat { message } → { reply, plan }. Plans only; nothing is executed here. Session required. */
export async function POST(req: Request) {
  const who = requireSession(req);
  if (who instanceof Response) return who;
  const wait = rateLimit(`chat:${who.principal}`, runQuotas().chatPerMinute);
  if (wait) return bad(`rate limited — retry in ${wait}s`, 429);
  const body = await readJson<{ message?: unknown }>(req);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return bad("message is required");
  if (message.length > MAX_MESSAGE) return bad(`message exceeds ${MAX_MESSAGE} characters`, 413);
  try {
    // Policy runs on every provider's output: validates, inserts probes, forces confirm, sets egress.
    const plan = { ...enforcePolicy(await getLlm().plan({ message }), message), owner: who.principal };
    savePlan(plan);
    const refused = plan.policy?.egressRefused ?? [];
    const reply = `${plan.summary} ${plan.steps.length} step(s) — each runs in its own sandbox that is destroyed afterwards.${
      plan.steps.some((s) => s.requiresConfirm) ? " I will ask before the final action." : ""
    }${refused.length ? ` Not on the server egress allowlist, so the sandbox will block: ${refused.join(", ")}.` : ""}`;
    return json({ reply, plan });
  } catch (e) {
    // Invalid plan from the planner = upstream failure; nothing runs.
    return bad((e as Error).message, 502);
  }
}
