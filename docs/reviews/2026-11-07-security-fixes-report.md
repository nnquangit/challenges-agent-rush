# ProofBox — security fixes report (2026-11-07)

Author: claude (Opus 5.5). Input: `docs/reviews/2026-11-07-final-readiness-review.md` (findings H1–H3, M1–M2, L1–L6). Workmap nodes T56 (ownership + API), T57 (low items), T58 (adversarial tests), T59 (security docs).
Scope: local repo, **mock runtime only**. No Vultr, lablab, git, deploy, tunnel or paid API. Own ports only: app 127.0.0.1:3167 (local mode) and 3168 (public mode with a throwaway token and key, and the config probe), docs 3169; every process was started and stopped by its PID.
Backup of the pre-fix files: `/Users/nnquangit/grokbot-export/secfix-20261107-213721/pre-fix/` (src, tests, scripts/*.mjs, README.md, docs/*.html). Docs backup (workdocs rule): `docs/.workdocs-backup/static-20261107-220324/`. Raw logs and screenshots: `/Users/nnquangit/grokbot-export/secfix-20261107-213721/evidence/`.
This is a fix of the reviewed findings plus what I found while fixing them, **not an exhaustive audit**.

## 1. Trust model (one design for server and UI)

- **Caller = session principal.** `POST /api/session` mints a random 128-bit principal and sets it in a cookie `pb_session` = `pb1.<principal>.<issuedAt>.<HMAC-SHA256>` (HttpOnly, SameSite=Strict, `Secure` in public mode, 12 h). The MAC covers a hash of the access token, so rotating the token ends every session. `src/lib/access.ts:35-70`, `src/app/api/session/route.ts:30-45`.
- **Token opens the door, it is not an identity.** With `PROOFBOX_DEMO_TOKEN` set, only minting a session needs `x-proofbox-token`; two people with the same token are two principals. Neither the token nor a client IP is ever used as identity.
- **Ownership.** Plans and runs carry `owner`. List, read, dispatch and confirm go through `ownPlan` / `ownRun` / `runsOf` (`src/lib/store.ts:34-43`); anything foreign answers the same 404 as "missing". Plans are single-use (`plan.runId`, 409 on re-dispatch).
- **Every API route** except status, public key and session calls `requireSession` (`src/lib/access.ts:123-129`); all routes first call `precheck` (`:104-121`): invalid config → 503, local mode + non-loopback `Host` → 403, cross-origin `Origin` on a POST → 403.
- **Exposure.** Local mode (default) = loopback `Host` only. `PROOFBOX_PUBLIC=1` = any host, but the server refuses to start without `PROOFBOX_DEMO_TOKEN` (≥ 16 chars) and a valid `RECEIPT_SIGNING_KEY` (`src/lib/config.ts:140-156`, `src/instrumentation.ts`, `src/lib/startup.ts`).
- **Server keeps owning policy**: probes, the forced confirm, the egress clamp and the slot cap are unchanged server code; the UI only reacts (token prompt, re-plan on Run again).
- **Local single-user UX**: unchanged except a `session: pr_…` chip (wide screens); the session is minted silently on load.

## 2. Before / after

| Id | Finding (review) | Before (pre-fix, observed) | After (observed) |
|---|---|---|---|
| H1 | Anyone can approve another user's paused submit | stranger confirm → **200**, submit ran (`pre-adv.log`) | stranger → **404**, gate untouched; owner's two concurrent approves → 200 + 409; replay → 409 |
| H2 | `/api/chat`, `/api/runs` open; plan re-dispatch; unbounded queue | chat/runs/exec without auth → 200/202; same plan dispatched again → 202; 4 runs from one client → 202×4 | no session → 401 on chat, runs, run, confirm, exec (token set and unset); re-dispatch → 409; 3rd active run → 429; queue bounded (12 total / 4 per principal) |
| H3 | Queued runs starve exec | newcomer exec during a flood → **429 after 8 ms** | newcomer exec → **200 after 247 ms**; flooder's excess → 429; slots and queue back to 0 |
| M1 | Rate limit trusts `X-Forwarded-For` | 25/25 × 200 with rotating XFF; policy probe 80 PASS / **1 FAIL** | 20/25 (limit holds); policy probe **82/82** |
| M2 | Anyone can read runs | B lists A's run; `GET /api/runs/:id` → 200 with plan, stdout | B sees 0 runs; read → 404 |
| L1 | `isForbiddenTarget` gaps | `[::7f00:1]`, `[64:ff9b::7f00:1]`, 198.18/15, 224/4, 240/4, 255.255.255.255, `localhost.` → null | all blocked; 17 new unit cases; public hosts still allowed |
| L2 | Host `Function()`; wrong Python arithmetic signed | `7//2`→3.5, `-7%3`→-1 | exact BigInt evaluator: `7//2`→3, `-7%3`→2, `-2**2`→-4; floats / `/` / ÷0 → "not evaluated"; no `Function()` |
| L3 | Simulated stderr unlabelled | no label | first stderr line `[mock] simulated stderr — …` inside the signed receipt; UI boxes "stdout · simulated by mock", "stderr · simulated by mock — no kernel enforced this" |
| L4 | `verify-receipt` default base and exit codes | default `localhost:3000`; unreachable base → uncaught, exit 1 | no default (exit 2); unreachable base / bad key → exit 3; invalid → 1; `--key-id` pin |
| L5 | Signing key fails lazily; persistence | bad key: server starts, fails at first seal | bad key (truncated DER, RSA) → server exits 1 at start, key never echoed; stable key → same keyId across restarts |
| L6 | In-memory, single process | — | documented; bounds kept; live runs never evicted from the store (deferred: see §4) |

## 3. Root cause and fix per item

**H1 / M2 — no caller identity anywhere.** Root cause: routes and `confirmStep` operated on bare ids (`src/app/api/runs/[id]/confirm/route.ts:7-16`, `src/lib/orchestrator.ts:34-45`, `src/app/api/runs/route.ts:19-28`, `src/app/api/runs/[id]/route.ts:7-11` in the backup). Fix: session principal (§1); `Run.owner`, `Plan.owner` (`src/lib/types.ts`); `confirmStep(runId, stepId, approve, principal)` uses `ownRun` and throws `RunRefused(404|409)` (`src/lib/orchestrator.ts:64-75`); list/read filter by owner (`src/app/api/runs/route.ts`, `src/app/api/runs/[id]/route.ts`). Decisions stay synchronous, so concurrent duplicates cannot both pass (one 200, one 409). An unanswered gate is denied after `CONFIRM_TTL_MS` (`src/lib/orchestrator.ts:78-91`, event `confirm.expired`).

**H2 — open planning/dispatch, reusable plans, unbounded waiters.** Root cause: no guard on chat/runs; a `planId` was a reusable capability; `waiters` was an unbounded array (`src/lib/sandbox/index.ts:19-25` in the backup). Fix: `requireSession` + per-principal limits (chat 20/min, runs 10/min) in `src/app/api/chat/route.ts`, `src/app/api/runs/route.ts`; `startRun(plan, owner)` admission control — owner check, single-use plan, ≤ 2 active runs per principal, ≤ 8 running globally (`src/lib/orchestrator.ts:33-51`); a bounded queue in the new `SlotPool`.

**H3 — FIFO queue + fail-fast exec.** Root cause: runs waited in one FIFO and every freed slot went to the next waiter, while exec failed immediately when no slot was free, so one client's queued runs denied exec to everyone. Fix: `src/lib/sandbox/slots.ts` — one pool for runs and exec; at most 2 slots per principal; per-principal queues served **round-robin**; queue bounds 12 total / 4 per principal; bounded waits (exec `SANDBOX_EXEC_WAIT_MS` 5 s, run step `SANDBOX_RUN_WAIT_MS` 120 s) → `SandboxBusy` (429); idempotent release; timed-out waiters remove themselves; idle principals leave no state. Wired in `src/lib/sandbox/index.ts:16-22,68`.

**M1 — spoofable XFF.** Root cause: `clientIp` took the left-most XFF value, which the client writes (`src/lib/rate-limit.ts:19-22` in the backup); App Router handlers have no socket address, so IP could not be identity anyway. Fix: `clientIp` returns `null` unless `PROOFBOX_TRUST_PROXY=<hops>`, then takes the entry `hops` places from the right and validates it with `net.isIP`; `x-real-ip` is ignored (`src/lib/rate-limit.ts:29-48`). Limits key on the principal; IP limits are an extra layer only behind a trusted proxy (exec, session minting).

**L1 — ad-hoc string tests.** Root cause: prefix/regex checks on the hostname text (`src/lib/sandbox/fixtures.ts:60-70` in the backup). Fix: `src/lib/sandbox/addresses.ts` parses IPv4 and IPv6 literals into numbers and classifies ranges (incl. IPv4-mapped/compatible, NAT64, 6to4, Teredo by the embedded IPv4; 198.18/15, 224/4, 240/4, TEST-NETs, ULA, link-local, site-local, multicast, AWS IPv6 IMDS) and canonicalises names (lower case, trailing dots; `localhost`, `*.localhost`, `*.internal`, `*.local`, metadata names). `isForbiddenTarget` → `classifyHost` (`src/lib/sandbox/fixtures.ts:75-80`). The allowlist still compares the exact hostname, so `EXAMPLE.COM.` stays refused (existing probe check kept). **DNS rebinding is not handled and cannot be tested in mock**: no name is resolved; the real egress proxy must resolve once, check with `classifyHost`, and connect to that address (comment in `addresses.ts`).

**L2 — `Function()` with JS semantics.** Root cause: regex-filtered JS evaluation, `//`→`/`, JS `%` (`src/lib/sandbox/mock-sandbox.ts:33-43` in the backup). Fix: `src/lib/sandbox/py-arith.ts` — recursive-descent parser over BigInt for Python integer arithmetic (`+ - * // % **`, unary, parentheses, `_` separators, Python precedence and floor semantics, size bounds); everything else returns null and the emulator prints `<mock: not evaluated: …>` (`src/lib/sandbox/mock-sandbox.ts:94`). The allocation estimate uses the same evaluator. No host `eval`/`Function` remains in `src/`.

**L3 — unlabelled simulated stderr.** Fix: `SIMULATED_STDERR_HEADER` prepended to every non-empty mock stderr before sealing (`src/lib/sandbox/mock-sandbox.ts:14,346`), plus UI labels (`src/components/ReceiptViewer.tsx:148-149`). `MockLlm` uses the last line / regex, so repair and explain are unaffected (smoke CSV repair still passes).

**L4 — verify-receipt.** Fix: rewritten `scripts/verify-receipt.mjs`: explicit key source required (`--key` or `--base`, not both), 5 s fetch timeout, exit 0 valid / 1 invalid / 2 usage / 3 key unavailable, `--key-id` pin, and a note that a same-server key is integrity, not independent trust.

**L5 — lazy key.** Fix: `loadKeys` validates base64, PKCS#8 parse and Ed25519 type with messages that never contain the key (`src/lib/sandbox/signing.ts:23-46`); `initSigningKey` runs at server start through `src/instrumentation.ts` → `src/lib/startup.ts:enforceStartup`, which exits 1 on any problem and otherwise logs one line (`exposure`, token set/unset, keyId, ephemeral). `.env.example` documents generating one stable key per deployment.

**L6.** Kept conservative bounds (store 200 entries, rate-limit windows 5000 keys with expired-first eviction, bounded slot queue) and documented the single-process limits (Security → Known gaps 4). `saveRun` now never evicts a live run (`src/lib/store.ts:24-31`).

## 4. Deferred / not fixed, with reason

- **Real isolation (C1), Vultr inference (C2)**: out of scope (mock-only phase; T39–T42 stay paused).
- **DNS rebinding / post-resolution check (L1 part)**: needs a resolving egress proxy; the mock resolves nothing, so any check would be untestable theatre. Designed note in `addresses.ts`.
- **Shared/persistent state (L6)**: a shared store or Redis is a deploy decision; one process on one VM is the stated plan. `PROOFBOX_SESSION_SECRET` lets sessions survive restarts, but runs and limits do not.
- **Sybil sessions**: anyone with the token (anyone, locally) can mint many principals; per-principal fairness does not stop that. Bounded by global caps (60 sessions/min, 8 running runs, 3 slots, queue 12) and, behind a trusted proxy, 10 sessions/min per IP. Real accounts would be needed to close it.

## 5. Commands and raw results (final code)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npx tsc --noEmit` (`npm run typecheck`) | 0 | no output |
| 2 | `npm test` | 0 | tests 117 · suites 17 · pass 117 · fail 0 · skipped 0 (47 confinement + 44 hardening + 26 access-model) |
| 3 | `npm run build` | 0 | Next.js 16.4.5, 0 warnings/errors; routes incl. `ƒ /api/session` |
| 4 | `next start -p 3167 -H 127.0.0.1` (token unset) | — | log `[proofbox] exposure=local token=unset trustProxyHops=0 receiptKey=b0ec… (ephemeral…)` |
| 5 | `PROOFBOX_PUBLIC=1 PROOFBOX_DEMO_TOKEN=… RECEIPT_SIGNING_KEY=… next start -p 3168` | — | log `exposure=public token=set … receiptKey=985a9f5dd33fb64c` (same keyId as an earlier start with the same key) |
| 6 | `npm run smoke -- http://127.0.0.1:3167` | 0 | 29 ✓, "all checks passed" |
| 7 | `PROOFBOX_DEMO_TOKEN=… npm run smoke -- http://127.0.0.1:3168` | 0 | 29 ✓ |
| 8 | smoke against 3168 **without** the token | 1 | `Error: /api/session → 401 missing or wrong x-proofbox-token` (expected) |
| 9 | `node --import tsx tests/server-policy.probe.mjs http://127.0.0.1:3167` | 0 | **82 PASS / 0 FAIL** (review: 80/1) |
| 10 | same against 3168 with token | 0 | 82 PASS / 0 FAIL |
| 11 | `node --import tsx tests/adversarial.probe.mjs http://127.0.0.1:3167` | 0 | 30 PASS / 0 FAIL |
| 12 | same against 3168 with token | 0 | 32 PASS / 0 FAIL (3 token checks instead of 1) |
| 13 | `node tests/config.probe.mjs . 3168` | 0 | 17 PASS / 0 FAIL |
| 14 | playwright-cli, app 3167, 1440×900 and 375×812 (`run-code`) | — | Prove-It 3/3, badge `CONTAINED (SIMULATED)`, verify "✓ sha256 … ✓ Ed25519 signature valid"; CSV 2/2 with `step.retry`; Research: dialog, focus on Deny → 4/5, "Nothing was submitted"; Run again (re-planned) → Approve → 5/5, "202 captured by fixture"; stderr label + header present; `scrollWidth` = viewport; session cookie not visible to JS; **0 console errors/warnings** at both widths |
| 15 | playwright-cli, public mode 3168 at `localhost` (final build, fresh throwaway token and key) | — | token prompt shown before any session request, presets disabled; wrong token → "That token was not accepted."; right token → session, prompt gone, Prove-It 3/3; console: one 401 line, the browser logging the deliberately wrong token |
| 16 | docs served alone on 3169: 8 pages × light/dark × 1440/375 (`run-code`) | — | 32 loads, 0 layout/h1 failures; 93 links and frames checked, **0 broken**; 0 requests to other origins; server log: **0** `.md`/`.json`/README requests; console: only the `favicon.ico` 404 |
| 17 | docs with `*.js` blocked | — | all required sections present on the six pages (5/7/5/5/5/8), nav 9 links |
| 18 | archify `finalize` architecture + sequence (`--quality showcase`) | 0 | validate/deliver/check/browser-check all pass; 2 advisory crossings on the architecture (one placement pass made it worse, so the passing layout was kept) |

## 6. Pre-fix failure evidence

The new tests were run against a copy of the project with the backed-up `src/`, `scripts/*.mjs` and `tests/` (built in `/tmp/pbsec/pre`, served on 3168, removed afterwards).

- `node --import tsx --test --test-skip-pattern="no key source" tests/hardening.test.ts` → exit 1, **11 pass / 32 fail**: all 17 new address cases, 7 arithmetic cases (`7//2` gave `3.5`, `-7%3` gave `-1`, `0.1+0.2` gave a number), both stderr-label cases, 3 XFF cases, 3 verify-receipt exit-code cases. The "no key source" case was skipped because the old script would fetch `http://localhost:3000` (off-limits port).
- `tests/adversarial.probe.mjs` against the pre-fix server → exit 1, **8 PASS / 22 FAIL**, e.g. `FAIL B cannot approve A's paused submit (H1) — HTTP 200`, `FAIL B cannot read A's run — HTTP 200 — leaked id,plan,status,steps,events,createdAt,mode`, `FAIL A cannot re-dispatch the same plan — HTTP 202`, `FAIL one principal: at most 2 active runs — 202,202,202,202`, `FAIL a newcomer's exec is served despite the flood — HTTP 429 after 8 ms`, `FAIL … 25 rotating XFF … — 25/25 × 200`, `FAIL unreachable --base → exit 3 — exit 1`.
- `tests/config.probe.mjs /tmp/pbsec/pre 3168` → exit 1, **7 PASS / 10 FAIL**: public mode without token/key starts (HTTP 200), malformed and RSA keys start, foreign `Host` → 200, no session endpoint (404).
- `tests/access-model.test.ts` imports modules that do not exist in the pre-fix code, so it cannot run there; its black-box twin is the adversarial probe above.
- The original review's own probe result (80 PASS / 1 FAIL, rotating XFF 25/25) is the pre-fix baseline for `server-policy.probe.mjs`.

## 7. Test changes to existing checks (intended behaviour changes)

- `tests/server-policy.probe.mjs` and `scripts/smoke.mjs`: now start a session (cookie) before calling the API, because every route needs one. No check was removed.
- Probe "6 parallel infinite loops → 3×200, 3×429" became "6 sessions → ≤ 3 live sandboxes (sampled), each 200 or 429": exec now waits fairly for a slot instead of failing fast (H3 fix). The global-cap invariant it stood for is still asserted, plus `tests/access-model.test.ts` asserts the cap and the bounds directly.
- Probe "5 concurrent runs" uses 5 sessions (2 active runs per session is now the limit).
- Probe "GET /api/runs lists runs without auth (note …)" — which passed while documenting the leak — became two stricter checks: no session → 401; a new session sees 0 runs.
- `tests/confinement.test.ts` is unchanged (47/47).

## 8. Changed files

Code: `src/lib/access.ts` (new), `src/lib/startup.ts` (new), `src/instrumentation.ts` (new), `src/app/api/session/route.ts` (new), `src/lib/sandbox/slots.ts` (new), `src/lib/sandbox/addresses.ts` (new), `src/lib/sandbox/py-arith.ts` (new); changed `src/lib/config.ts`, `src/lib/rate-limit.ts`, `src/lib/store.ts`, `src/lib/orchestrator.ts`, `src/lib/types.ts`, `src/lib/sandbox/index.ts`, `src/lib/sandbox/signing.ts`, `src/lib/sandbox/fixtures.ts`, `src/lib/sandbox/mock-sandbox.ts`, `src/app/api/{chat,runs,runs/[id],runs/[id]/confirm,sandbox/exec,status,receipts/public-key}/route.ts`, `src/components/ProofBoxApp.tsx`, `src/components/ReceiptViewer.tsx`.
Scripts and tests: `scripts/verify-receipt.mjs`, `scripts/smoke.mjs`, `tests/server-policy.probe.mjs`; new `tests/hardening.test.ts`, `tests/access-model.test.ts`, `tests/adversarial.probe.mjs`, `tests/config.probe.mjs`, `tests/lib/pb-client.mjs`.
Docs and config: `docs/index.html`, `setup.html`, `how-it-works.html`, `security.html`, `api.html`, `demo.html`, `diagrams.html`; `docs/diagrams/architecture-current.html` and `docs/diagrams/sequence-confirm-gate.html` regenerated from `.archify/architecture-proofbox-current-20261107-220549/` and `.archify/sequence-confirm-gate-20261107-220809/` (old sources kept); `README.md`; `.env.example` (new variables; original saved to the backup folder as `pre-fix/.env.example`); `CLAUDE.md` (one line: new diagram source path); this report. Workmap via `scripts/workmap.py` only.

## 9. New known gaps (after the fixes)

1. Sybil sessions bounded only by global caps (and per-IP behind a trusted proxy).
2. No post-DNS-resolution egress check (must be built into the real proxy).
3. All state in memory, one process.
4. The local-mode `Host` check is not a network control: bind to 127.0.0.1; a client that reaches an exposed port can forge `Host: localhost`.
5. A request in the instant between "Ready" and the startup check could be served before a bad key stops the process (config errors are re-checked per request; the key is not).
6. The mock print emulator now refuses floats and `/` (honest, but shows less).
7. **`docs/media/proofbox-demo.mp4` shows the OLD UI/behaviour**: no session chip, unlabelled stdout/stderr, old "Run again" message, old arithmetic. Flagged on `docs/demo.html` (video section) and in the README. Not re-rendered.
8. Diagrams other than architecture and confirm-gate (`sequence-plan-run`, `lifecycle-run-step`, `workflow-policy`, `dataflow-receipt`) were not regenerated; they do not show the session layer but contain nothing the fixes made false.

## 10. Verdict

| Target | Verdict |
|---|---|
| **Local demo (mock)** | **GO.** All checks above pass, token unset and set; the three presets, Deny/Approve and receipt verification work at 1440 and 375 with 0 console errors. |
| **Public deploy (mock build)** | **Conditional.** H1/H2/H3/M1/M2 are fixed and public mode fails safe. Deploy only with `PROOFBOX_PUBLIC=1`, a strong `PROOFBOX_DEMO_TOKEN`, a stable `RECEIPT_SIGNING_KEY`, `PROOFBOX_TRUST_PROXY=1` behind exactly one appending proxy, one process; accept gaps 1–5 above. It would still be a mock: no user code runs. |
| **Hackathon submission (Challenge 1)** | **NO-GO, unchanged blockers:** real isolated sandbox (Docker + gVisor runner implementing `VultrSandbox`), Vultr Serverless Inference (`VultrInferenceLlm`), a Vultr VM deployment and public demo URL, a public GitHub repo, slides and a cover image, and a re-recorded video with a real containment moment (the current video also shows the pre-fix UI). |

Archify reported an available update (3.0.1 → 3.2.0); nothing was installed.
