import { precheck } from "@/lib/access";
import { json } from "@/lib/http";
import { publicKeyInfo } from "@/lib/sandbox/signing";

export const dynamic = "force-dynamic";

/** GET /api/receipts/public-key → { alg, keyId, spki (base64 DER), ephemeral }. No session needed. */
export function GET(req: Request) {
  const fail = precheck(req);
  if (fail) return fail;
  return json(publicKeyInfo());
}
