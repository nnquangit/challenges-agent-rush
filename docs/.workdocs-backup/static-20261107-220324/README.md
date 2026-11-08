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
npm test               # unit tests, no server: policy, egress, redaction, receipt signing (47 tests)
npm run smoke -- http://localhost:3000   # E2E: presets + policy + ad-hoc exec, 29 checks (server must be running)
npm run verify-receipt -- receipt.json --base http://localhost:3000   # check a downloaded receipt offline
```

No `.env` file is needed. `MOCK` defaults to on. `.env.example` lists the variables the Vultr phase will use. **Do not** put real keys in the repo.

## Demo presets

| Preset | Pattern | What it shows |
|---|---|---|
| **Prove-It Python** | A · code | Runs a snippet that claims "sum of primes < 100 = 1060", returns a receipt with sha256. Then a **containment probe** tries to read secrets, `/host`, cloud metadata and `docker ps` (all blocked), and a **resource probe** allocates 2 GB and is OOM-killed at the 256 MiB cap. |
| **CSV Analyst** | A · code | The planner writes pandas code using the word the user said (`revenue`). The first attempt fails with `KeyError`, the error goes back to the LLM, which fixes the column (`revenue_usd`) and retries. Output: summary table + bar chart. An exfiltration probe tries to POST the CSV out and is blocked. |
| **Research with Receipts** | B · browser | A sandboxed browser opens an allowlisted page, captures a screenshot as evidence, "vision" checks it (Pro = $29/month), proves `169.254.169.254` is unreachable, fills a form as a draft, then **stops for a human Approve/Deny** before submitting. |

## What is simulated (read this first)

Nothing in this build runs in a real container or VM yet.

- **`MockSandbox` does not execute code.** It pattern-matches the snippet and returns fixture output (a small `print()` emulator, canned pages, SVG "screenshots", a simulated clock). Free-form code may print `<mock: not evaluated: …>`.
- **"Blocked" escape attempts are simulated.** The probe code is matched against rules (secrets, `/host`, metadata, `docker ps`, egress) in software. The rules are the policy a real sandbox must enforce; they are not proof that a kernel enforced them.
- **`MockLlm` is a template planner.** Only the presets give meaningful plans.
- The UI says so: every receipt from the mock shows **`CONTAINED (SIMULATED)`** and the line "no container or VM ran". `isolation.simulated` and `clock: "simulated"` are inside the signed receipt.

What *is* real today: the control-plane rules (plan validation, server-inserted probes, human gate, server egress allowlist, rate limit and concurrency cap on `/api/sandbox/exec`), secret redaction, and the receipt hash + signature. Those are the parts that stay the same when the real sandbox is plugged in.

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
| Human gate | `submit` always `requiresConfirm` (policy + orchestrator) | Approve/Deny dialog, Deny by default | same |
| Only planner-made plans run | `POST /api/runs` takes a `planId`, not steps | ✓ | ✓ |
| Abuse limits | `/api/sandbox/exec`: per-IP rate limit, max concurrent sandboxes (429), optional `PROOFBOX_DEMO_TOKEN` | ✓ | ✓ |
| Verifiable receipt | sha256 + Ed25519 over the canonical JSON of the **whole** receipt (isolation, limits, env, timestamps), sealed after `destroy()` (`src/lib/receipt-canonical.ts`, `src/lib/sandbox/signing.ts`) | ✓ ephemeral demo key unless `RECEIPT_SIGNING_KEY` is set | ✓ |
| Badge from evidence | `src/lib/containment.ts`: `CONTAINED` / `UNVERIFIED` / `NOT CONTAINED` | shows `CONTAINED (SIMULATED)` | `CONTAINED` |

## API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/status` | – | mode, llm, sandbox, default limits, egress allowlist, sandbox slots |
| `POST` | `/api/chat` | `{ message }` | `{ reply, plan }` — plan after `enforcePolicy` (runs nothing); `502` if the planner's plan is invalid |
| `POST` | `/api/runs` | `{ planId }` | `202 { run }` — starts the run in the background |
| `GET` | `/api/runs` | – | recent run summaries |
| `GET` | `/api/runs/:id` | – | full run: steps, receipts, timeline |
| `POST` | `/api/runs/:id/confirm` | `{ stepId, approve }` | human decision for a paused step |
| `POST` | `/api/sandbox/exec` | `{ kind: "code", code, files? }` or `{ kind: "browser", url, action?, expect? }` | one-off receipt (no `submit` here). Egress = server allowlist; sending `egressAllowlist` → `400`. `401` without `x-proofbox-token` when `PROOFBOX_DEMO_TOKEN` is set; `429` when rate-limited or all sandbox slots are busy |
| `GET` | `/api/receipts/public-key` | – | `{ alg: "Ed25519", keyId, spki, ephemeral }` for verifying receipts |

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
    rate-limit.ts           per-IP fixed-window limit
    llm/                    LlmProvider, MockLlm, VultrInferenceLlm (stub)
    sandbox/                SandboxProvider, MockSandbox, VultrSandbox (stub), redact, fixtures, signing
    presets.ts              demo presets
scripts/smoke.mjs           E2E smoke test
scripts/verify-receipt.mjs  offline receipt check (sha256 + Ed25519)
tests/                      unit tests (npm test)
docs/                       reader docs (static HTML), architecture diagram, work map
PLAN.md                     hackathon plan
```

## Known gaps

Open issues are listed with file references on `docs/security.html` ("Known gaps"). The main ones: no real sandbox yet (blocker for the Vultr phase); `/api/chat` and `/api/runs` have no token or rate limit; the rate limit trusts `X-Forwarded-For`; runs are readable by anyone who knows the id; `isForbiddenTarget` misses a few address ranges; limits are kept in memory.

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
| `docs/media/proofbox-demo.mp4` | Recorded demo video of the mock build (2:37, captions in `.srt`); sources and licences in `video/README.md` |
| `docs/diagrams.html` | Architecture, sequence, lifecycle, data-flow and policy diagrams (Archify, sources in `.archify/`) |
| `docs/workmap.html` | Work map, generated by `scripts/workmap.py` from `docs/shared/workmap.md` |

## License

MIT — see [LICENSE](LICENSE).
