"use client";

import { useEffect, useRef } from "react";
import type { PlanStep, Run } from "@/lib/types";

/** Human gate before a browser final action. Deny is the default focus. */
export default function ConfirmDialog({ run, step, busy, onDecide }: { run: Run; step: PlanStep; busy: boolean; onDecide: (approve: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    denyRef.current?.focus();
    return () => d?.close();
  }, []);

  // Show the latest draft screenshot so the human sees exactly what would be sent.
  const draft = [...run.steps]
    .reverse()
    .flatMap((s) => s.attempts.at(-1)?.artifacts ?? [])
    .find((a) => a.kind === "image" && a.name === "form-draft.svg");

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onDecide(false);
      }}
      aria-labelledby="confirm-title"
      className="m-auto w-[min(720px,calc(100vw-2rem))] rounded-xl border border-amber-500/40 bg-panel p-0 text-zinc-200 shadow-2xl"
    >
      <div className="border-b border-line px-5 py-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber-300">Human confirmation required</p>
        <h2 id="confirm-title" className="mt-1 text-lg font-semibold text-zinc-50">
          {step.title}
        </h2>
        <p className="mt-1 text-sm text-zinc-400">{step.description}</p>
      </div>
      <div className="space-y-3 px-5 py-4">
        <dl className="grid grid-cols-[90px_1fr] gap-y-1 font-mono text-xs">
          <dt className="text-zinc-500">action</dt>
          <dd>{step.browser?.action}</dd>
          <dt className="text-zinc-500">target</dt>
          <dd className="break-all">{step.browser?.url}</dd>
          {Object.entries(step.browser?.fields ?? {}).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {draft && <img src={draft.content} alt="Draft form as filled inside the sandbox" className="max-h-64 w-full rounded border border-line object-contain" />}
        <p className="text-xs text-zinc-400">
          In mock mode an approved submit is captured by the sandbox fixture server — nothing reaches the real site. Deny is the default: nothing leaves without an explicit yes.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <button ref={denyRef} disabled={busy} onClick={() => onDecide(false)} className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-white/5 disabled:opacity-50">
          Deny
        </button>
        <button disabled={busy} onClick={() => onDecide(true)} className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-50">
          Approve submit
        </button>
      </div>
    </dialog>
  );
}
