"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRESETS } from "@/lib/presets";
import type { Plan, PlanStep, Run, StepRun, TimelineEvent } from "@/lib/types";
import ConfirmDialog from "./ConfirmDialog";
import ReceiptViewer from "./ReceiptViewer";
import { Panel, StatusChip, shortTime } from "./ui";

interface Msg {
  role: "user" | "agent" | "error";
  text: string;
}
interface Status {
  mode: "mock" | "vultr";
  llm: string;
  sandbox: string;
  limits: { timeoutMs: number; memoryMb: number };
  access?: { exposure: "local" | "public"; tokenRequired: boolean };
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function rawApi<T>(url: string, init?: RequestInit, extraHeaders: Record<string, string> = {}): Promise<T> {
  // Same-origin fetch sends the HttpOnly session cookie (pb_session) set by POST /api/session.
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...extraHeaders }, cache: "no-store", credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data.code);
  return data as T;
}

// The access token (only when the server asks for one) stays in memory; the session cookie does the rest.
let accessToken: string | null = null;
const startSession = (token = accessToken) =>
  rawApi<{ session: { principal: string } }>("/api/session", { method: "POST", body: "{}" }, token ? { "x-proofbox-token": token } : {});

/** API call with the caller's session; a missing or expired session is renewed once. */
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    return await rawApi<T>(url, init);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "session_required") throw e;
    await startSession();
    return rawApi<T>(url, init);
  }
}

export default function ProofBoxApp() {
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Msg[]>([
    { role: "agent", text: "Give me a task. I plan it, run every step in its own throwaway sandbox, and hand back receipts you can verify. Try a preset →" },
  ]);
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [lastMessage, setLastMessage] = useState("");
  // Session: "ready" (cookie set), "token" (server needs an access token first), or an error.
  const [session, setSession] = useState<{ state: "starting" | "ready" | "token"; principal?: string; error?: string }>({ state: "starting" });
  const [tokenInput, setTokenInput] = useState("");

  const openSession = useCallback(async (token?: string) => {
    try {
      const { session: s } = await startSession(token ?? accessToken);
      if (token) accessToken = token;
      setSession({ state: "ready", principal: s.principal });
    } catch (e) {
      const err = e as ApiError;
      setSession(err.code === "token_required" ? { state: "token", error: token ? "That token was not accepted." : undefined } : { state: "starting", error: err.message });
    }
  }, []);

  useEffect(() => {
    api<Status>("/api/status")
      .then((st) => {
        setStatus(st);
        // A token-protected server: ask for the token first instead of a request that must fail.
        if (st.access?.tokenRequired && !accessToken) setSession({ state: "token" });
        else void openSession();
      })
      .catch(() => {
        setStatus(null);
        void openSession();
      });
  }, [openSession]);

  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setLastMessage(message);
    try {
      const { reply, plan } = await api<{ reply: string; plan: Plan }>("/api/chat", { method: "POST", body: JSON.stringify({ message }) });
      setMessages((m) => [...m, { role: "agent", text: reply }]);
      setPlan(plan);
      setRun(null);
      setSelected(plan.steps[0]?.id ?? null);
      setPinned(false);
    } catch (e) {
      setMessages((m) => [...m, { role: "error", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }, []);

  const dispatch = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      // Plans are single-use on the server: "Run again" asks the planner again for the same task.
      let next = plan;
      if (run) {
        next = (await api<{ reply: string; plan: Plan }>("/api/chat", { method: "POST", body: JSON.stringify({ message: lastMessage }) })).plan;
        setPlan(next);
        setSelected(next.steps[0]?.id ?? null);
      }
      const { run: started } = await api<{ run: Run }>("/api/runs", { method: "POST", body: JSON.stringify({ planId: next.id }) });
      setRun(started);
      setPinned(false);
      setMessages((m) => [...m, { role: "agent", text: `${run ? "Re-planned (plans are single-use) and dispatched" : "Dispatched"} ${started.id}. Watch the timeline — each step gets a fresh sandbox.` }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "error", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  // Poll the run until it finishes.
  const runId = run?.id;
  const live = run?.status === "running" || run?.status === "awaiting_confirm";
  useEffect(() => {
    if (!runId || !live) return;
    const t = setInterval(async () => {
      try {
        const { run } = await api<{ run: Run }>(`/api/runs/${runId}`);
        setRun(run);
      } catch {
        /* keep polling */
      }
    }, 450);
    return () => clearInterval(t);
  }, [runId, live]);

  // Follow the active step unless the user picked one.
  useEffect(() => {
    if (!run || pinned) return;
    const active = run.steps.find((s) => s.status === "running" || s.status === "awaiting_confirm") ?? [...run.steps].reverse().find((s) => s.attempts.length || s.status === "skipped");
    if (active) setSelected(active.stepId);
  }, [run, pinned]);

  const chatBox = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = chatBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const prevStatus = useRef<Run["status"] | null>(null);
  useEffect(() => {
    if (!run || run.status === prevStatus.current) return;
    prevStatus.current = run.status;
    if (run.status === "succeeded" || run.status === "failed") {
      const ok = run.steps.filter((s) => s.status === "succeeded").length;
      setMessages((m) => [...m, { role: "agent", text: `Run ${run.status}: ${ok}/${run.steps.length} steps succeeded. Every sandbox was destroyed. Click a step for its receipt.` }]);
    }
  }, [run]);

  const decide = async (approve: boolean, stepId: string) => {
    if (!run) return;
    setConfirmBusy(true);
    try {
      const res = await api<{ run: Run }>(`/api/runs/${run.id}/confirm`, { method: "POST", body: JSON.stringify({ stepId, approve }) });
      setRun(res.run);
    } catch (e) {
      setMessages((m) => [...m, { role: "error", text: (e as Error).message }]);
    } finally {
      setConfirmBusy(false);
    }
  };

  const stepRuns = useMemo(() => new Map(run?.steps.map((s) => [s.stepId, s])), [run]);
  const selStep = plan?.steps.find((s) => s.id === selected) ?? null;
  const selRun = selected ? stepRuns.get(selected) : undefined;
  const awaiting = run?.status === "awaiting_confirm" ? run.steps.find((s) => s.status === "awaiting_confirm") : undefined;
  const awaitingStep = awaiting && plan?.steps.find((s) => s.id === awaiting.stepId);

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden="true">
            <rect x="3" y="3" width="26" height="26" rx="6" fill="none" stroke="#34d399" strokeWidth="2.5" />
            <path d="M10 16.5l4 4 8-9" fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-50">ProofBox</h1>
            <p className="font-mono text-[11px] text-zinc-500">plan → dispatch into a sandbox → verifiable receipt</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          {status ? (
            <>
              <span className={`rounded-md border px-2 py-1 ${status.mode === "mock" ? "border-amber-500/50 text-amber-300" : "border-emerald-500/50 text-emerald-300"}`}>
                {status.mode === "mock" ? "MOCK MODE · no Vultr calls" : "VULTR MODE"}
              </span>
              <span className="rounded-md border border-line px-2 py-1 text-zinc-400">sandbox: {status.sandbox}</span>
              <span className="hidden rounded-md border border-line px-2 py-1 text-zinc-400 md:inline">llm: {status.llm}</span>
              <span className="hidden rounded-md border border-line px-2 py-1 text-zinc-400 sm:inline">
                caps: {status.limits.timeoutMs} ms · {status.limits.memoryMb} MiB
              </span>
              {session.principal && (
                <span className="hidden rounded-md border border-line px-2 py-1 text-zinc-400 lg:inline" title="Your session principal: runs you start are visible only to this session">
                  session: {session.principal}
                </span>
              )}
            </>
          ) : (
            <span className="text-zinc-500">connecting…</span>
          )}
        </div>
      </header>

      <main className="grid flex-1 gap-3 p-3 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Column 1: presets + chat */}
        <Panel title="Task" className="lg:min-h-0">
          <div className="flex h-full flex-col">
            {session.state === "token" && (
              <form
                className="space-y-2 border-b border-amber-500/30 bg-amber-500/[0.05] p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (tokenInput.trim()) void openSession(tokenInput.trim());
                }}
              >
                <label htmlFor="access-token" className="block text-sm font-medium text-amber-200">
                  This server needs an access token
                </label>
                <p className="text-xs text-zinc-400">It starts a private session: the runs you start are visible only to you.</p>
                <div className="flex gap-2">
                  <input
                    id="access-token"
                    type="password"
                    autoComplete="off"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-amber-500/50 focus:outline-none"
                  />
                  <button disabled={!tokenInput.trim()} className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-40">
                    Start session
                  </button>
                </div>
                {session.error && <p className="text-xs text-rose-300">{session.error}</p>}
              </form>
            )}
            {session.state === "starting" && session.error && <p className="border-b border-line p-3 text-xs text-rose-300">Could not start a session: {session.error}</p>}
            <div className="grid gap-2 border-b border-line p-3">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  disabled={busy || session.state !== "ready"}
                  onClick={() => send(p.message)}
                  className="group rounded-lg border border-line bg-white/[0.02] p-2.5 text-left transition hover:border-emerald-500/40 hover:bg-emerald-500/[0.04] disabled:opacity-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-zinc-100">{p.title}</span>
                    <span className="font-mono text-[10px] text-zinc-500">{p.pattern}</span>
                  </div>
                  <p className="mt-0.5 text-xs leading-snug text-zinc-400">{p.blurb}</p>
                </button>
              ))}
            </div>
            <ol ref={chatBox} className="max-h-[50vh] min-h-40 flex-1 space-y-2 overflow-y-auto p-3 lg:max-h-none" aria-live="polite">
              {messages.map((m, i) => (
                <li
                  key={i}
                  className={`max-w-[95%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed ${
                    m.role === "user" ? "ml-auto max-h-48 overflow-y-auto bg-indigo-500/15 font-mono text-xs text-indigo-100" : m.role === "error" ? "bg-rose-500/10 text-rose-200" : "bg-white/[0.04] text-zinc-200"
                  }`}
                >
                  {m.text}
                </li>
              ))}
            </ol>
            <form
              className="border-t border-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <label htmlFor="task" className="sr-only">
                Describe a task
              </label>
              <textarea
                id="task"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(input);
                }}
                rows={3}
                placeholder="e.g. Run this Python… / Analyze this CSV… / Open https://… and capture evidence"
                className="w-full resize-none rounded-lg border border-line bg-black/30 p-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-[10px] text-zinc-600">⌘/Ctrl + Enter</span>
                <button disabled={busy || !input.trim() || session.state !== "ready"} className="rounded-lg bg-zinc-100 px-3.5 py-1.5 text-sm font-semibold text-black hover:bg-white disabled:opacity-40">
                  Plan it
                </button>
              </div>
            </form>
          </div>
        </Panel>

        {/* Column 2: plan board + timeline */}
        <div className="grid min-h-0 gap-3 lg:grid-rows-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Panel
            title="Plan board"
            right={
              plan && (
                <button
                  onClick={dispatch}
                  disabled={busy || live}
                  className="rounded-md bg-emerald-400 px-3 py-1 text-xs font-semibold text-black hover:bg-emerald-300 disabled:opacity-40"
                >
                  {run ? (live ? "Running…" : "Run again") : "Dispatch to sandbox →"}
                </button>
              )
            }
          >
            {plan ? (
              <div className="h-full overflow-y-auto p-3">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-zinc-100">{plan.title}</h3>
                  {run && <StatusChip status={run.status} />}
                </div>
                <ol className="space-y-2">
                  {plan.steps.map((s, i) => (
                    <StepCard
                      key={s.id}
                      n={i + 1}
                      step={s}
                      sr={stepRuns.get(s.id)}
                      active={selected === s.id}
                      onClick={() => {
                        setSelected(s.id);
                        setPinned(true);
                      }}
                    />
                  ))}
                </ol>
              </div>
            ) : (
              <Empty text="No plan yet. Pick a preset or describe a task." />
            )}
          </Panel>
          <Panel title="Run timeline" right={run && <span className="font-mono text-[11px] text-zinc-500">{run.id}</span>}>
            {run ? <Timeline events={run.events} onPick={(id) => (setSelected(id), setPinned(true))} /> : <Empty text="Dispatch a plan to see sandboxes created, executed and destroyed." />}
          </Panel>
        </div>

        {/* Column 3: receipt */}
        <Panel title="Receipt" className="grid-paper">
          <div className="h-full overflow-y-auto">
            {selStep && selRun ? (
              <ReceiptViewer key={`${run?.id}-${selStep.id}`} step={selStep} run={selRun} />
            ) : selStep ? (
              <PlannedStep step={selStep} />
            ) : (
              <Empty text="Receipts show stdout/stderr, exit code, artifacts, the env the sandbox saw, and the isolation report." />
            )}
          </div>
        </Panel>
      </main>

      {run && awaiting && awaitingStep && <ConfirmDialog key={awaiting.stepId} run={run} step={awaitingStep} busy={confirmBusy} onDecide={(ok) => decide(ok, awaiting.stepId)} />}
    </div>
  );
}

function StepCard({ n, step, sr, active, onClick }: { n: number; step: PlanStep; sr?: StepRun; active: boolean; onClick: () => void }) {
  const last = sr?.attempts.at(-1);
  return (
    <li>
      <button
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={`w-full rounded-lg border p-3 text-left transition ${active ? "border-emerald-500/50 bg-emerald-500/[0.05]" : "border-line bg-white/[0.015] hover:border-zinc-600"}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-600 font-mono text-[10px] text-zinc-400">{n}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">{step.title}</p>
              <p className="mt-0.5 text-xs leading-snug text-zinc-400">{step.description}</p>
            </div>
          </div>
          {sr ? <StatusChip status={sr.status} /> : <span className="font-mono text-[11px] text-zinc-600">planned</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 pl-7 font-mono text-[10px]">
          <Tag>{step.kind === "code" ? "A · code" : `B · ${step.browser?.action}`}</Tag>
          {step.probe && <Tag tone="emerald">{step.addedBy === "policy" ? "containment probe · policy" : "containment probe"}</Tag>}
          {step.requiresConfirm && <Tag tone="amber">human confirm</Tag>}
          {sr && sr.attempts.length > 1 && <Tag tone="sky">{sr.attempts.length} attempts</Tag>}
          {last && <Tag>exit {last.exitCode}</Tag>}
          {last && last.isolation.blockedAttempts.length > 0 && <Tag tone="emerald">{last.isolation.blockedAttempts.length} blocked</Tag>}
          {last?.killedBy && <Tag tone="emerald">killed: {last.killedBy}</Tag>}
        </div>
      </button>
    </li>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "emerald" | "amber" | "sky" }) {
  const c = tone === "emerald" ? "border-emerald-500/40 text-emerald-300" : tone === "amber" ? "border-amber-500/40 text-amber-300" : tone === "sky" ? "border-sky-500/40 text-sky-300" : "border-line text-zinc-500";
  return <span className={`rounded border px-1.5 py-0.5 ${c}`}>{children}</span>;
}

const EVENT_TONE: Partial<Record<TimelineEvent["type"], string>> = {
  "sandbox.created": "text-sky-300",
  "sandbox.destroyed": "text-zinc-400",
  containment: "text-emerald-300",
  "step.failed": "text-rose-300",
  "step.retry": "text-amber-300",
  "confirm.requested": "text-amber-300",
  "confirm.approved": "text-amber-200",
  "confirm.denied": "text-amber-200",
  "confirm.expired": "text-amber-200",
  "llm.explain": "text-indigo-300",
  "llm.verify": "text-indigo-300",
  "step.succeeded": "text-emerald-300",
  "run.finished": "text-zinc-100",
};

function Timeline({ events, onPick }: { events: TimelineEvent[]; onPick: (stepId: string) => void }) {
  const box = useRef<HTMLOListElement>(null);
  // Stick to the newest event without scrolling the page itself.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <ol ref={box} className="h-full max-h-[50vh] space-y-0.5 overflow-y-auto p-3 font-mono text-[11px] lg:max-h-none">
      {events.map((e, i) => (
        <li key={i} className="grid grid-cols-[56px_118px_1fr] gap-2 rounded px-1 py-0.5 hover:bg-white/[0.03]">
          <span className="text-zinc-600">{shortTime(e.at)}</span>
          <span className={EVENT_TONE[e.type] ?? "text-zinc-400"}>{e.type}</span>
          <span className="break-words text-zinc-300">
            {e.stepId && (
              <button className="mr-1 text-zinc-500 hover:text-zinc-200" onClick={() => onPick(e.stepId!)}>
                [{e.stepId}]
              </button>
            )}
            {e.message}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PlannedStep({ step }: { step: PlanStep }) {
  return (
    <div className="space-y-3 p-4">
      <p className="font-mono text-[11px] text-zinc-500">
        {step.id} · planned · not dispatched yet
      </p>
      <h3 className="text-base font-semibold text-zinc-100">{step.title}</h3>
      <p className="text-sm text-zinc-400">{step.description}</p>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-black/40 p-3 font-mono text-xs text-zinc-200">
        {step.kind === "code" ? step.code : JSON.stringify(step.browser, null, 2)}
      </pre>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-sm leading-relaxed text-zinc-500">{text}</p>;
}
