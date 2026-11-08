// Containment verdict from the evidence in a receipt — never a constant.
import type { Receipt } from "./types";

export type ContainmentLevel = "contained" | "unverified" | "breach";

export function containmentVerdict(r: Receipt, probe: boolean): { level: ContainmentLevel; reasons: string[] } {
  const iso = r.isolation;
  const blocked = iso.blockedAttempts.length;
  if (iso.hostTouched === true) return { level: "breach", reasons: ["provider reported the host was touched"] };
  if (probe && blocked === 0 && !r.killedBy) return { level: "breach", reasons: ["containment probe ran and nothing was blocked"] };
  const missing: string[] = [];
  if (iso.hostTouched !== false) missing.push("no hostTouched evidence");
  if (!iso.destroyed) missing.push("sandbox not reported destroyed");
  if (!r.sha256 || !r.signature) missing.push("receipt not sealed");
  if (missing.length) return { level: "unverified", reasons: missing };
  const reasons = ["destroyed after exec", "hostTouched=false"];
  if (probe) reasons.push(r.killedBy ? `killed by ${r.killedBy} cap` : `${blocked} escape attempt(s) blocked`);
  return { level: "contained", reasons };
}
