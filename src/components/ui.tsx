import type { RunStatus, StepStatus } from "@/lib/types";

type AnyStatus = StepStatus | RunStatus;

const STYLE: Record<AnyStatus, string> = {
  pending: "border-zinc-700 text-zinc-400",
  running: "border-sky-500/50 bg-sky-500/10 text-sky-300",
  awaiting_confirm: "border-amber-500/60 bg-amber-500/10 text-amber-300",
  succeeded: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-500/60 bg-rose-500/10 text-rose-300",
  skipped: "border-zinc-600 bg-zinc-700/20 text-zinc-400",
};

const LABEL: Record<AnyStatus, string> = {
  pending: "pending",
  running: "running",
  awaiting_confirm: "needs your OK",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "skipped",
};

export function StatusChip({ status }: { status: AnyStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide ${STYLE[status]}`}>
      {(status === "running" || status === "awaiting_confirm") && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" />}
      {LABEL[status]}
    </span>
  );
}

export function Panel({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel/90 ${className}`} aria-label={title}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export const shortTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
