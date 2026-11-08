// Sandbox slots: a global cap on live sandboxes, shared fairly between principals.
//
// - At most `maxConcurrent` slots in use; one principal holds at most `slotsPerPrincipal`.
// - Callers that cannot start wait in a per-principal queue. The queue is bounded
//   globally (`maxQueued`) and per principal (`queuePerPrincipal`); beyond that, or
//   after `maxWaitMs`, the caller gets SandboxBusy (HTTP 429). Nothing waits forever.
// - A freed slot goes to the next principal in round-robin order, so one caller
//   flooding the queue cannot starve others (previously: one FIFO, and runs took
//   every slot while ad-hoc exec failed fast).
// - Release is idempotent; timed-out waiters remove themselves; empty per-principal
//   entries are deleted, so the pool holds no state for idle principals.

export class SandboxBusy extends Error {}

export interface SlotLimits {
  maxConcurrent: number;
  slotsPerPrincipal: number;
  maxQueued: number;
  queuePerPrincipal: number;
}

interface Waiter {
  principal: string;
  grant: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class SlotPool {
  private active = 0;
  private activeBy = new Map<string, number>();
  /** Insertion order = round-robin order; a principal moves to the end after being served. */
  private queues = new Map<string, Waiter[]>();
  private queued = 0;

  constructor(private limits: () => SlotLimits) {}

  private cap(L: SlotLimits) {
    return Math.max(1, Math.min(L.slotsPerPrincipal, L.maxConcurrent));
  }

  private canStart(p: string, L: SlotLimits) {
    return this.active < L.maxConcurrent && (this.activeBy.get(p) ?? 0) < this.cap(L) && !this.queues.has(p);
  }

  private start(p: string): () => void {
    this.active++;
    this.activeBy.set(p, (this.activeBy.get(p) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const n = (this.activeBy.get(p) ?? 1) - 1;
      if (n > 0) this.activeBy.set(p, n);
      else this.activeBy.delete(p);
      this.pump();
    };
  }

  private remove(w: Waiter) {
    const q = this.queues.get(w.principal);
    const i = q?.indexOf(w) ?? -1;
    if (!q || i < 0) return false;
    q.splice(i, 1);
    this.queued--;
    if (!q.length) this.queues.delete(w.principal);
    return true;
  }

  private pump() {
    const L = this.limits();
    while (this.active < L.maxConcurrent) {
      let next: Waiter | undefined;
      for (const [p, q] of this.queues) {
        if ((this.activeBy.get(p) ?? 0) >= this.cap(L)) continue;
        next = q[0];
        break;
      }
      if (!next) return;
      this.remove(next);
      // Round-robin: a principal that still has waiters goes to the back.
      const rest = this.queues.get(next.principal);
      if (rest) {
        this.queues.delete(next.principal);
        this.queues.set(next.principal, rest);
      }
      if (next.timer) clearTimeout(next.timer);
      next.grant();
    }
  }

  /** Resolves with a release function. maxWaitMs 0 = fail fast; Infinity = wait (still bounded by the queue limits). */
  acquire(principal: string, maxWaitMs: number): Promise<() => void> {
    const L = this.limits();
    if (this.canStart(principal, L)) return Promise.resolve(this.start(principal));
    if (maxWaitMs <= 0) return Promise.reject(new SandboxBusy(`all ${L.maxConcurrent} sandbox slots are busy (or your share of ${this.cap(L)} is in use) — retry shortly`));
    if (this.queued >= L.maxQueued) return Promise.reject(new SandboxBusy(`sandbox queue is full (${L.maxQueued} waiting) — retry shortly`));
    const mine = this.queues.get(principal);
    if ((mine?.length ?? 0) >= L.queuePerPrincipal) return Promise.reject(new SandboxBusy(`you already have ${L.queuePerPrincipal} requests waiting for a sandbox — retry shortly`));
    return new Promise((resolve, reject) => {
      const w: Waiter = { principal, grant: () => resolve(this.start(principal)) };
      if (Number.isFinite(maxWaitMs))
        w.timer = setTimeout(() => {
          if (this.remove(w)) reject(new SandboxBusy(`no sandbox slot within ${maxWaitMs} ms — retry shortly`));
        }, maxWaitMs);
      if (mine) mine.push(w);
      else this.queues.set(principal, [w]);
      this.queued++;
    });
  }

  stats() {
    const L = this.limits();
    return { active: this.active, queued: this.queued, max: L.maxConcurrent, perPrincipal: this.cap(L), maxQueued: L.maxQueued, principalsWaiting: this.queues.size, principalsActive: this.activeBy.size };
  }
}
