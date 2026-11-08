# ProofBox

**Containment-first agent control plane.** You give ProofBox a task. It plans the steps, runs each step in its own sandbox that is thrown away afterwards, and hands back a **receipt** you can check: stdout/stderr, exit code, artifacts, the env the sandbox saw, an isolation report, and a sha256 + Ed25519 signature over all of it, which you can verify in the browser or offline.

Built for [Vultr: Agent Rush](https://lablab.ai/ai-hackathons/vultr-hackathon), **Challenge 1: Blast Radius Zero**.

> **Current phase: mock-first.** Every LLM call, sandbox, browser and VM is mocked. The app makes **no** calls to Vultr (`api.vultrinference.com`, VMs) or any other external service. The UI labels everything as `MOCK MODE` / `simulated`.

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

Optional checks:

```bash
npm run typecheck      # tsc --noEmit
npm run build          # production build
npm test               # unit tests, no server: policy, egress, redaction, signing, sessions, ownership, slot pool (117 tests)
npm run smoke -- http://localhost:3000   # E2E: presets + policy + ad-hoc exec, 29 checks (server must be running)
npm run verify-receipt -- receipt.json --base http://localhost:3000   # check a downloaded receipt offline (or --key <spki>)
node --import tsx tests/adversarial.probe.mjs http://localhost:3000  # two sessions, confirm hijack/replay, queue flood, XFF (30 checks; 32 with a token)
```

No `.env` file is needed for local use. `MOCK` defaults to on, and the server runs in **local mode**: the API answers only `localhost` / `127.0.0.1` hosts. To expose it, set `PROOFBOX_PUBLIC=1` together with `PROOFBOX_DEMO_TOKEN` (≥ 16 characters) and a stable `RECEIPT_SIGNING_KEY` — without them the server refuses to start. `.env.example` lists every variable. **Do not** put real keys in the repo.

### Who can see and approve what

Each browser (or script) gets its own **session principal**: `POST /api/session` sets an HttpOnly, SameSite=Strict, HMAC-signed cookie. Plans and runs belong to that principal — list, read, dispatch and the human Approve/Deny only reach your own (anyone else gets `404`), and a plan can be dispatched once. When `PROOFBOX_DEMO_TOKEN` is set, starting a session needs header `x-proofbox-token`; the token opens the door but is not an identity. Limits are per principal (chat, runs, exec, active runs) plus global caps, and sandbox slots are shared round-robin with a bounded queue. `x-forwarded-for` is read only with `PROOFBOX_TRUST_PROXY=<hops>`. Scripts: `curl -c jar -b jar -X POST $BASE/api/session` once, then `-b jar` on each call; `scripts/smoke.mjs` does this itself.

## Demo presets

| Preset | Pattern | What it shows |
|---|---|---|
| **Prove-It Python** | A · code | Runs a snippet that claims "sum of primes < 100 = 1060", returns a receipt with sha256. Then a **containment probe** tries to read secrets, `/host`, cloud metadata and `docker ps` (all blocked), and a **resource probe** allocates 2 GB and is OOM-killed at the 256 MiB cap. |
| **CSV Analyst** | A · code | The planner writes pandas code using the word the user said (`revenue`). The first attempt fails with `KeyError`, the error goes back to the LLM, which fixes the column (`revenue_usd`) and retries. Output: summary table + bar chart. An exfiltration probe tries to POST the CSV out and is blocked. |
| **Research with Receipts** | B · browser | A sandboxed browser opens an allowlisted page, captures a screenshot as evidence, "vision" checks it (Pro = $29/month), proves `169.254.169.254` is unreachable, fills a form as a draft, then **stops for a human Approve/Deny** before submitting. |

## What is simulated (read this first)

Nothing in this build runs in a real container or VM yet.

- **`MockSandbox` does not execute code.** It pattern-matches the snippet and returns fixture output (a small `print()` emulator that evaluates only exact Python integer arithmetic, canned pages, SVG "screenshots", a simulated clock). Free-form code prints `<mock: not evaluated: …>`, and every mock stderr starts with `[mock] simulated stderr — …`.
- **"Blocked" escape attempts are simulated.** The probe code is matched against rules (secrets, `/host`, metadata, `docker ps`, egress) in software. The rules are the policy a real sandbox must enforce; they are not proof that a kernel enforced them.
- **`MockLlm` is a template planner.** Only the presets give meaningful plans.
- The UI says so: every receipt from the mock shows **`CONTAINED (SIMULATED)`** and the line "no container or VM ran". `isolation.simulated` and `clock: "simulated"` are inside the signed receipt.

What *is* real today: the control-plane rules (plan validation, server-inserted probes, owner-only human gate, server egress allowlist), the access model (session principal, ownership, per-principal limits, fair bounded sandbox queue, refuse-to-start in public mode), secret redaction, and the receipt hash + signature. Those are the parts that stay the same when the real sandbox is plugged in.

## Vultr services used

Status on 2026-11-07: **none yet.** No Vultr account is connected and the app makes no Vultr calls. This is the plan for the submission build; this section will be updated with the real plan/region/model once deployed.

| Service | Role in ProofBox | Status |
|---|---|---|
| Vultr Cloud Compute (VM) | Hosts the Next.js web app + API and the sandbox runner | planned — not deployed |
| Vultr Serverless Inference (`https://api.vultrinference.com/v1`, OpenAI-compatible) | Every LLM call: `plan`, `repair`, `explain`, `verify` (`src/lib/llm/vultr-inference-llm.ts`, stub) | planned — stub only, never called |
| Docker (+ gVisor `runsc`) on the VM | One container per step: `--network none` or egress proxy, read-only rootfs, `--memory`, `--pids-limit`, `--cap-drop ALL`, non-root (`src/lib/sandbox/vultr-sandbox.ts`, stub) | planned — stub only |

No Vultr GPU is used (not allowed in this event).

## How it works

```
Browser UI (Next.js)
  → POST /api/chat                 LlmProvider.plan()  → Plan JSON (stored server-side)
  → POST /api/runs {planId}        orchestrator: for each step
        ├─ requiresConfirm? → pause, wait for POST /api/runs/:id/confirm
        └─ runInSandbox(): redact env → create → exec → artifacts → destroy() in finally
              SandboxProvider
                ├─ MockSandbox    ← in use: fixtures, mock clock, caps, egress policy
                └─ VultrSandbox   ← stub: same interface, no network yet
        on code failure → LlmProvider.repair() → retry once
        browser step   → LlmProvider.verify() (vision check)
        every step     → LlmProvider.explain()
  → GET  /api/runs/:id             receipts + timeline + isolation reports (UI polls)
```

Readable docs with an animated flow and a step player: `docs/how-it-works.html` (see "Documentation" below).

### Containment-first guarantees

| Guarantee | Where | Mock today | Vultr phase |
|---|---|---|---|
| One fresh sandbox per step, always destroyed | `src/lib/sandbox/index.ts` (`finally { destroy() }`) | ✓ receipt shows `destroyed: true` | container removed |
| Secrets never enter | `src/lib/sandbox/redact.ts` `buildSandboxEnv` | host env dropped; `VULTR_*`/`PROOFBOX_*` secrets show as `[REDACTED]` | same code |
| Secrets never leave | `redactText` on stdout/stderr/artifacts | host secret values + token shapes (`sk-…`, `ghp_…`, JWT, AWS) scrubbed | same code |
| Time cap | `SANDBOX_TIMEOUT_MS` (default 5000, max 30000) | mock clock, exit 124 | `timeout` + kill process group |
| Memory cap | `SANDBOX_MEMORY_MB` (default 256, max 1024) | allocation estimate, exit 137 | cgroup `--memory` |
| Egress policy | server allowlist `SANDBOX_EGRESS_ALLOWLIST` (`src/lib/config.ts`); plan allowlist = hosts **the user typed** ∩ server list (`src/lib/policy.ts`); re-clamped in `runInSandbox` | deny-all for code; allowlist proxy for browser; metadata/loopback/private ranges always blocked | `--network none` / egress proxy |
| Plans are validated | `validatePlan` in `src/lib/policy.ts` (max 8 steps, kinds, code size, http(s) URLs) | invalid plan → 502, nothing runs | same code |
| Probes are inserted by the server | `enforcePolicy` appends standard probes; LLM-set `probe` flags are cleared | ✓ (`addedBy: "policy"`) | same code |
| Human gate | `submit` always `requiresConfirm` (policy + orchestrator); only the run's owner decides, once (`confirmStep`) | Approve/Deny dialog, Deny by default | same |
| Only planner-made plans run | `POST /api/runs` takes the caller's own `planId`, not steps; plans are single-use | ✓ | ✓ |
| Private runs | session principal in a signed cookie (`src/lib/access.ts`); runs listed/read/confirmed only by their owner | ✓ | ✓ |
| Abuse limits | per-principal limits on session, chat, runs, exec; 2 active runs per principal; fair `SlotPool` (`src/lib/sandbox/slots.ts`): 3 slots, 2 per principal, bounded queue, round-robin, bounded waits (429); optional `PROOFBOX_DEMO_TOKEN` gates sessions; `PROOFBOX_PUBLIC=1` refuses to start without token + key | ✓ in memory | ✓ |
| Verifiable receipt | sha256 + Ed25519 over the canonical JSON of the **whole** receipt (isolation, limits, env, timestamps), sealed after `destroy()` (`src/lib/receipt-canonical.ts`, `src/lib/sandbox/signing.ts`) | ✓ ephemeral demo key unless `RECEIPT_SIGNING_KEY` is set | ✓ |
| Badge from evidence | `src/lib/containment.ts`: `CONTAINED` / `UNVERIFIED` / `NOT CONTAINED` | shows `CONTAINED (SIMULATED)` | `CONTAINED` |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/status` | – | mode, llm, sandbox, default limits, egress allowlist, sandbox slots, `access` (exposure, `tokenRequired`) |
| `POST` | `/api/session` | `{}` (+ `x-proofbox-token` when a token is set) | sets the `pb_session` cookie (new principal); `401` without the right token; `429` too many new sessions |
| `POST` | `/api/chat` | `{ message }` | `{ reply, plan }` — plan after `enforcePolicy` (runs nothing), owned by the caller; `502` if the planner's plan is invalid |
| `POST` | `/api/runs` | `{ planId }` | `202 { run }` — starts the run in the background; `404` foreign/unknown plan, `409` plan already used, `429` too many active runs |
| `GET` | `/api/runs` | – | the caller's recent run summaries |
| `GET` | `/api/runs/:id` | – | full run (owner only, else `404`): steps, receipts, timeline |
| `POST` | `/api/runs/:id/confirm` | `{ stepId, approve }` | human decision for a paused step (owner only, else `404`; second decision `409`) |
| `POST` | `/api/sandbox/exec` | `{ kind: "code", code, files? }` or `{ kind: "browser", url, action?, expect? }` | one-off receipt (no `submit` here). Egress = server allowlist; sending `egressAllowlist` → `400`; `429` when rate-limited or no fair slot within 5 s |
| `GET` | `/api/receipts/public-key` | – | `{ alg: "Ed25519", keyId, spki, ephemeral }` for verifying receipts |

Every route except status, session and public key needs the session cookie (`401` otherwise). In local mode every route answers `403` to a non-loopback `Host`; a cross-origin POST gets `403`; an invalid security config gets `503`. `verify-receipt` exits `0` valid, `1` invalid, `2` usage, `3` key unavailable, and has no default `--base`.

## Mock now vs Vultr later

| Piece | Now (`MOCK=1`, default) | Later (`MOCK=0`, after accounts are approved) |
|---|---|---|
| LLM | `MockLlm` — template plans by intent (code / csv / browser), no model | `VultrInferenceLlm` → Vultr Serverless Inference, OpenAI-compatible `https://api.vultrinference.com/v1/chat/completions`, JSON plan output |
| Sandbox | `MockSandbox` — fixtures, print() emulator, SVG screenshots, mock clock. **User code is never executed on the host.** | `VultrSandbox` → runner on a Vultr VM starting Docker (gVisor), non-root, read-only rootfs, no capabilities, `--network none` or egress proxy, cgroup limits |
| Browser | canned fixture pages | Playwright inside the container |
| Hosting | `npm run dev` locally | web app + backend on a Vultr VM |
| Storage | in-memory | in-memory or small DB |

Switching providers is a factory change (`getLlm()`, `getSandboxProvider()`); the UI and API stay the same. The stubs refuse to run while `MOCK=1` and make no network calls even with `MOCK=0` in this phase.

## Project layout

```
src/
  app/                      Next.js App Router: page + API routes
  components/               ProofBoxApp, ReceiptViewer, ArtifactViewer, IsolationBadge, ConfirmDialog
  lib/
    types.ts                Plan, Run, Receipt, IsolationReport …
    orchestrator.ts         plan walk, retry, human gate, timeline
    policy.ts               control-plane rules: validate plan, insert probes, force confirm, egress
    containment.ts          containment verdict from receipt evidence
    receipt-canonical.ts    canonical receipt payload (server, browser, verify script)
    access.ts               session principal (signed cookie), Host/Origin checks, config refusal
    rate-limit.ts           fixed-window limit per principal (client IP only behind a trusted proxy)
    llm/                    LlmProvider, MockLlm, VultrInferenceLlm (stub)
    sandbox/                SandboxProvider, MockSandbox, VultrSandbox (stub), redact, fixtures, addresses,
                            signing, slots (fair bounded pool), py-arith (exact integer evaluator)
    presets.ts              demo presets
scripts/smoke.mjs           E2E smoke test
scripts/verify-receipt.mjs  offline receipt check (sha256 + Ed25519)
tests/                      unit tests (npm test) + black-box probes (*.probe.mjs, need a server)
docs/                       reader docs (static HTML), architecture diagram, work map
PLAN.md                     hackathon plan
```

## Known gaps

Open issues are listed with file references on `docs/security.html` ("Known gaps"). The main ones: no real sandbox yet (blocker for the Vultr phase); anyone with the token (or anyone, locally) can open many sessions, bounded only by global caps; no egress check after DNS resolution (must be built into the real egress proxy); sessions, runs and limits are in memory, one process. Fixed on 2026-11-07 (see `docs/reviews/2026-11-07-security-fixes-report.md`): confirm by anyone, open chat/runs with an unbounded queue, trusted `X-Forwarded-For`, readable runs, address-range gaps, wrong mock arithmetic, unlabelled simulated stderr, `verify-receipt` defaults, late signing-key failure.

## Documentation

Static HTML in `docs/`, no build step and no network requests. Open `docs/index.html` directly, or serve the folder:

```bash
python3 -m http.server 4590 --bind 127.0.0.1 --directory docs   # http://127.0.0.1:4590/
```

| Page | Content |
|---|---|
| `docs/index.html` | Overview: what is real vs simulated, architecture |
| `docs/setup.html` | Install, configuration, tests, verification |
| `docs/how-it-works.html` | Animated flow and step-by-step run |
| `docs/security.html` | Threats, controls, evidence, known gaps |
| `docs/api.html` | HTTP routes, shapes, errors, curl |
| `docs/demo.html` | 3-minute demo script |
| `docs/media/proofbox-demo.mp4` | Recorded demo video of the mock build (2:37, captions in `.srt`); sources and licences in `video/README.md`. **Recorded before the 2026-11-07 security fixes**: it shows the old UI (no session chip, unlabelled stderr, old "Run again"); not re-rendered |
| `docs/diagrams.html` | Architecture, sequence, lifecycle, data-flow and policy diagrams (Archify, sources in `.archify/`) |
| `docs/workmap.html` | Work map, generated by `scripts/workmap.py` from `docs/shared/workmap.md` |

## License

MIT — see [LICENSE](LICENSE).
