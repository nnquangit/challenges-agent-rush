import { isMock, defaultLimits, egressAllowlist, demoToken, exposure, trustProxyHops } from "@/lib/config";
import { precheck } from "@/lib/access";
import { json } from "@/lib/http";
import { getLlm } from "@/lib/llm";
import { getSandboxProvider, sandboxStats } from "@/lib/sandbox";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const fail = precheck(req);
  if (fail) return fail;
  return json({
    mode: isMock() ? "mock" : "vultr",
    llm: getLlm().name,
    sandbox: getSandboxProvider().name,
    limits: defaultLimits(),
    egressAllowlist: egressAllowlist(),
    sandboxes: sandboxStats(),
    access: { exposure: exposure(), tokenRequired: Boolean(demoToken()), session: "cookie pb_session (POST /api/session)", trustProxyHops: trustProxyHops() },
    /** Kept for older clients: true when a token is needed (it now gates POST /api/session). */
    adhocExecToken: Boolean(demoToken()),
  });
}
