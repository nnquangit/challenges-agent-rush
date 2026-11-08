"use client";

import { useEffect, useState } from "react";
import { receiptPayload } from "@/lib/receipt-canonical";
import type { PlanStep, Receipt, StepRun } from "@/lib/types";
import ArtifactViewer from "./ArtifactViewer";
import IsolationBadge from "./IsolationBadge";
import { StatusChip } from "./ui";

type VerifyState = { state: "idle" | "checking" } | { state: "done"; hashOk: boolean; sigOk: boolean | null; note: string };

let keyCache: Promise<{ keyId: string; spki: string; ephemeral: boolean }> | null = null;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Recompute sha256 and check the Ed25519 signature in the browser (WebCrypto). */
async function verifyReceipt(r: Receipt): Promise<Extract<VerifyState, { state: "done" }>> {
  const payload = new TextEncoder().encode(receiptPayload(r as unknown as Record<string, unknown>));
  const hashOk = hex(await crypto.subtle.digest("SHA-256", payload)) === r.sha256;
  keyCache ??= fetch("/api/receipts/public-key").then((res) => res.json());
  const key = await keyCache;
  if (key.keyId !== r.signature?.keyId) return { state: "done", hashOk, sigOk: false, note: "signed by a different key (server restarted with an ephemeral key?)" };
  try {
    const pub = await crypto.subtle.importKey("spki", b64(key.spki), { name: "Ed25519" }, false, ["verify"]);
    const sigOk = await crypto.subtle.verify({ name: "Ed25519" }, pub, b64(r.signature.value), payload);
    return { state: "done", hashOk, sigOk, note: `key ${key.keyId}${key.ephemeral ? " (ephemeral demo key)" : ""}` };
  } catch {
    return { state: "done", hashOk, sigOk: null, note: "this browser has no Ed25519 in WebCrypto — use scripts/verify-receipt.mjs" };
  }
}

function download(r: Receipt) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `receipt-${r.sandboxId}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TABS = ["output", "artifacts", "code", "env", "raw"] as const;
type Tab = (typeof TABS)[number];

export default function ReceiptViewer({ step, run }: { step: PlanStep; run: StepRun }) {
  const [attemptIdx, setAttemptIdx] = useState(run.attempts.length - 1);
  const [tab, setTab] = useState<Tab>("output");
  const [check, setCheck] = useState<VerifyState>({ state: "idle" });
  // Follow the newest attempt as it arrives; show screenshots first for browser steps.
  useEffect(() => {
    setAttemptIdx(run.attempts.length - 1);
  }, [run.attempts.length]);
  useEffect(() => {
    setTab(step.kind === "browser" ? "artifacts" : "output");
  }, [step.id, step.kind]);

  const r = run.attempts[attemptIdx];
  useEffect(() => {
    setCheck({ state: "idle" });
  }, [r?.sha256]);
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[11px] text-zinc-500">
            {step.id} · {step.kind === "code" ? "Pattern A · code" : "Pattern B · browser"}
            {step.probe && " · containment probe"}
            {step.addedBy === "policy" && " · added by policy"}
          </p>
          <h3 className="text-base font-semibold text-zinc-100">{step.title}</h3>
        </div>
        <StatusChip status={run.status} />
      </div>

      {run.explanation && <p className="rounded-lg border border-indigo-500/25 bg-indigo-500/[0.06] p-3 text-sm leading-relaxed text-indigo-100">{run.explanation}</p>}
      {run.verdict && (
        <p className={`font-mono text-xs ${run.verdict.ok ? "text-emerald-300" : "text-rose-300"}`}>
          {run.verdict.ok ? "✓" : "✗"} {run.verdict.notes}
        </p>
      )}

      {!r ? (
        <p className="text-sm text-zinc-500">{run.status === "awaiting_confirm" ? "Waiting for your decision before anything runs." : run.status === "skipped" ? "Not executed." : "No receipt yet."}</p>
      ) : (
        <>
          {run.attempts.length > 1 && (
            <div className="flex gap-1.5" role="tablist" aria-label="Attempts">
              {run.attempts.map((a, i) => (
                <button
                  key={a.sandboxId}
                  role="tab"
                  aria-selected={i === attemptIdx}
                  onClick={() => setAttemptIdx(i)}
                  className={`rounded-md border px-2 py-1 font-mono text-[11px] ${i === attemptIdx ? "border-zinc-400 text-zinc-100" : "border-line text-zinc-500 hover:text-zinc-300"}`}
                >
                  attempt {a.attempt} · exit {a.exitCode}
                </button>
              ))}
            </div>
          )}
          <IsolationBadge receipt={r} probe={Boolean(step.probe)} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-400">
            <span>
              exit <b className={r.exitCode === 0 ? "text-emerald-300" : "text-rose-300"}>{r.exitCode}</b>
              {r.killedBy && <span className="text-amber-300"> (killed: {r.killedBy})</span>}
            </span>
            <span className="truncate" title={r.sha256}>
              sha256 {r.sha256.slice(0, 16)}…
            </span>
            <button className="text-zinc-500 underline-offset-2 hover:text-zinc-200 hover:underline" onClick={() => navigator.clipboard?.writeText(r.sha256)}>
              copy
            </button>
            <button
              className="rounded border border-line px-1.5 py-0.5 text-zinc-300 hover:border-emerald-400 hover:text-emerald-200 disabled:opacity-50"
              disabled={check.state === "checking"}
              onClick={async () => {
                setCheck({ state: "checking" });
                setCheck(await verifyReceipt(r).catch(() => ({ state: "done" as const, hashOk: false, sigOk: null, note: "could not fetch the public key" })));
              }}
            >
              {check.state === "checking" ? "verifying…" : "verify"}
            </button>
            <button className="rounded border border-line px-1.5 py-0.5 text-zinc-300 hover:border-zinc-400" onClick={() => download(r)}>
              download receipt.json
            </button>
          </div>
          {check.state === "done" && (
            <p role="status" className={`font-mono text-[11px] ${check.hashOk && check.sigOk ? "text-emerald-300" : check.sigOk === null && check.hashOk ? "text-amber-300" : "text-rose-300"}`}>
              {check.hashOk ? "✓" : "✗"} sha256 recomputed in your browser · {check.sigOk ? "✓ Ed25519 signature valid" : check.sigOk === null ? "? signature not checked" : "✗ signature invalid"} — {check.note}
            </p>
          )}

          <div className="flex gap-1 border-b border-line" role="tablist" aria-label="Receipt sections">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-2.5 py-1.5 font-mono text-xs ${tab === t ? "border-emerald-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
              >
                {t}
                {t === "artifacts" && ` (${r.artifacts.length})`}
              </button>
            ))}
          </div>

          {tab === "output" && (
            <div className="space-y-2">
              <p className="font-mono text-[11px] text-zinc-500">$ {r.command}</p>
              <Pre label={r.isolation.simulated ? "stdout · simulated by mock" : "stdout"} text={r.stdout} />
              <Pre label={r.isolation.simulated ? "stderr · simulated by mock — no kernel enforced this" : "stderr"} text={r.stderr} tone="err" />
            </div>
          )}
          {tab === "artifacts" && <ArtifactViewer artifacts={r.artifacts} />}
          {tab === "code" && <Pre label={step.kind === "code" ? `main.py · attempt ${r.attempt}` : "browser action"} text={r.input} />}
          {tab === "env" && (
            <div>
              <p className="mb-2 text-xs text-zinc-400">Environment as the sandbox saw it. Host secrets keep their names but never their values; everything else from the host is dropped.</p>
              <Pre label="env" text={Object.entries(r.envInjected).map(([k, v]) => `${k}=${v}`).join("\n")} />
            </div>
          )}
          {tab === "raw" && <Pre label="receipt.json" text={JSON.stringify({ ...r, artifacts: r.artifacts.map(({ content, ...a }) => ({ ...a, bytes: content.length })) }, null, 2)} />}
        </>
      )}
    </div>
  );
}

function Pre({ label, text, tone }: { label: string; text: string; tone?: "err" }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-black/40">
      <div className="border-b border-line px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <pre className={`max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed ${tone === "err" ? "text-rose-200/90" : "text-zinc-200"}`}>
        {text || <span className="text-zinc-600">(empty)</span>}
      </pre>
    </div>
  );
}
