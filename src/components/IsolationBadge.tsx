import { containmentVerdict } from "@/lib/containment";
import type { Receipt } from "@/lib/types";

const TONE = {
  contained: { box: "border-emerald-500/30 bg-emerald-500/[0.06]", chip: "bg-emerald-400/15 text-emerald-300" },
  unverified: { box: "border-zinc-500/40 bg-zinc-500/[0.06]", chip: "bg-zinc-400/15 text-zinc-300" },
  breach: { box: "border-rose-500/40 bg-rose-500/[0.08]", chip: "bg-rose-400/15 text-rose-300" },
};

/** Proof that a step ran contained, computed from the receipt's evidence (src/lib/containment.ts). */
export default function IsolationBadge({ receipt, probe = false }: { receipt: Receipt; probe?: boolean }) {
  const iso = receipt.isolation;
  const blocked = iso.blockedAttempts.length;
  const v = containmentVerdict(receipt, probe);
  const label = v.level === "contained" ? (iso.simulated ? "CONTAINED (SIMULATED)" : "CONTAINED") : v.level === "breach" ? "NOT CONTAINED" : "UNVERIFIED";
  return (
    <div className={`rounded-lg border p-3 ${TONE[v.level].box}`} title={v.reasons.join(" · ")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs font-semibold ${TONE[v.level].chip}`}>
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M8 1l6 2.5v4c0 3.6-2.5 6.3-6 7.5C4.5 13.8 2 11.1 2 7.5v-4z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M5.2 8l2 2 3.6-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {label}
        </span>
        {iso.simulated && <span className="rounded-md border border-amber-500/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-300">simulated · {iso.provider}</span>}
        <span className="font-mono text-[11px] text-zinc-400">{receipt.sandboxId}</span>
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] sm:grid-cols-3">
        <Item k="hostTouched" v={String(iso.hostTouched)} good={iso.hostTouched === false} />
        <Item k="destroyed" v={iso.destroyed ? "true" : "false"} good={iso.destroyed} />
        <Item k="blocked" v={String(blocked)} good={blocked > 0} />
        <Item k="memory" v={`${receipt.peakMemoryMb}/${receipt.limits.memoryMb} MiB`} good={receipt.killedBy !== "memory"} />
        <Item k="time" v={`${receipt.durationMs}/${receipt.limits.timeoutMs} ms`} good={receipt.killedBy !== "timeout"} />
        <Item k="redacted" v={String(receipt.redactions)} good />
      </dl>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-zinc-400">
        net: {iso.networkPolicy} · pid: {iso.pidNamespace} · user: {iso.user}
      </p>
      <p className="mt-1 font-mono text-[11px] text-zinc-500">evidence: {v.reasons.join(" · ")}</p>
      {iso.simulated && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300/90">
          Simulated by {iso.provider}: no container or VM ran. The control plane enforced these rules in software; real isolation (Docker/gVisor on a Vultr VM) is not wired yet.
        </p>
      )}
    </div>
  );
}

function Item({ k, v, good }: { k: string; v: string; good?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-500">{k}</dt>
      <dd className={good ? "text-emerald-300" : "text-zinc-300"}>{v}</dd>
    </div>
  );
}
