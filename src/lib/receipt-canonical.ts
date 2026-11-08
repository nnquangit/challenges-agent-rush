// Canonical form of a receipt — shared by the server (seal), the browser
// (Verify button) and scripts/verify-receipt.mjs. Pure TS, no imports, so all
// three compute byte-identical input.
//
// payload = canonical JSON of the whole receipt minus `sha256` and `signature`
// (sorted keys at every level, undefined dropped, like JSON.stringify).
// sha256 = hex(SHA-256(payload)); signature = Ed25519(payload).

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** Fields that are not part of the signed payload. */
export const UNSIGNED_FIELDS = ["sha256", "signature"] as const;

export function receiptPayload(receipt: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...receipt };
  for (const f of UNSIGNED_FIELDS) delete rest[f];
  return canonicalJson(rest);
}
