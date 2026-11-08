// In-memory store — enough for a local demo. Kept on globalThis so Next.js dev
// hot reloads and separate route modules share one instance.
import type { Plan, Run } from "./types";

interface Store {
  plans: Map<string, Plan>;
  runs: Map<string, Run>;
  /** Runs currently being advanced (prevents double execution). */
  locks: Set<string>;
}

const g = globalThis as unknown as { __proofbox?: Store };
export const store: Store = (g.__proofbox ??= { plans: new Map(), runs: new Map(), locks: new Set() });

// Bounded: oldest entries go first, but runs still in progress are never evicted
// (their number is capped by RUNS_ACTIVE_MAX / RUNS_ACTIVE_PER_PRINCIPAL).
const MAX_ENTRIES = 200;
const live = (r: Run) => r.status === "running" || r.status === "awaiting_confirm";

export function savePlan(p: Plan) {
  store.plans.set(p.id, p);
  while (store.plans.size > MAX_ENTRIES) store.plans.delete(store.plans.keys().next().value as string);
}
export function saveRun(r: Run) {
  store.runs.set(r.id, r);
  if (store.runs.size <= MAX_ENTRIES) return;
  for (const [id, old] of store.runs) {
    if (store.runs.size <= MAX_ENTRIES) break;
    if (!live(old)) store.runs.delete(id);
  }
}

/** The caller's own plan, or undefined (also for someone else's plan: no existence oracle). */
export function ownPlan(id: unknown, principal: string) {
  const p = typeof id === "string" ? store.plans.get(id) : undefined;
  return p && p.owner === principal ? p : undefined;
}
/** The caller's own run, or undefined. */
export const ownRun = (id: string, principal: string) => {
  const r = store.runs.get(id);
  return r && r.owner === principal ? r : undefined;
};
export const runsOf = (principal: string) => [...store.runs.values()].filter((r) => r.owner === principal);
export const isLive = live;
