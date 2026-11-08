# ProofBox — final readiness review (2026-11-07)

Reviewer: claude (Opus 5.5). Type: test and review only, nothing fixed. Workmap node: T55 "Review sẵn sàng nộp".
Scope: the code as it is on disk on 2026-11-07 (no git history). Mock mode only. No Vultr, lablab login, deploy, git or Docker. Servers: app on 127.0.0.1:3157, docs on 127.0.0.1:3158, both started and stopped by PID. Throwaway scripts and logs are in `/tmp/pbfinal/`.

## 1. Verdict

| Target | Verdict | Why |
|---|---|---|
| **Local demo (mock)** | **GO** | typecheck clean, 47/47 unit tests, build OK, smoke 29/29, all three presets work in Chromium at 1440 and 375 with 0 console errors, the confirm gate works (Deny → 4/5, Approve → 5/5), and the receipt verifies in the browser and from the CLI. The UI and video label everything as simulated. |
| **Public deploy (as is)** | **NO-GO** | No deploy exists. Even on the mock build: **any visitor can approve someone else's paused submit** (new, H1), `/api/chat` and `/api/runs` have no token or rate limit, queued runs take every sandbox slot so `/api/sandbox/exec` returns 429 for everyone, the rate limit trusts `X-Forwarded-For`, and every run can be read without auth. |
| **Hackathon submission (Challenge 1)** | **NO-GO** | The hard requirements are missing: no real isolated sandbox (`VultrSandbox.create` throws), no Vultr Serverless Inference (`VultrInferenceLlm` is a stub that always throws), no Vultr VM, no public demo URL, no public GitHub repo (the folder is not a git repo), and no slides or cover image. The video exists and has audio, but its containment moment is the mock, labelled as simulated. |

## 2. Tests run (raw results)

| # | Command | Exit | Raw result |
|---|---|---|---|
| 1 | `npm run typecheck` | 0 | `tsc --noEmit`, no output |
| 2 | `npm test` | 0 | tests 47 · suites 6 · pass 47 · fail 0 · skipped 0 · duration 2209 ms |
| 3 | `npm run build` | 0 | Next.js 16.4.5 (Turbopack), compiled; routes `/`, 7 API routes |
| 4 | `npx next start -p 3157 -H 127.0.0.1` (= `npm start` on a free port; 3000 is off-limits for this review) | — | listening; `GET /api/status` 200, `mode: mock`, `sandboxes {active 0, queued 0, max 3}`, `adhocExecToken: false` |
| 5 | `npm run smoke -- http://127.0.0.1:3157` | 0 | 29 ✓, "all checks passed" |
| 6 | `node --import tsx tests/server-policy.probe.mjs http://127.0.0.1:3157` | **1** | **80 PASS / 1 FAIL**: `rotating x-forwarded-for cannot bypass the limit — 25/25 × 200`. The info-exposure check passes but only records "11 runs visible without auth". |
| 7 | `node /tmp/pbfinal/regress.mjs` and `regress2.mjs` (HTTP regression) | 0 | see §4 |
| 8 | `node --import tsx /tmp/pbfinal/forbidden.ts` (calls `isForbiddenTarget` directly) | 0 | 7 of 15 URLs not forbidden, see §4(d) |
| 9 | `node --import tsx /tmp/pbfinal/signing.ts` ×2 without key, ×2 with a locally generated dummy key (value never printed) | 0 | without key: keyId `be46fc39…` then `ae669a95…`, `ephemeral: true`; with key: `9e25707b…` both times, `ephemeral: false` |
| 10 | `npm run verify-receipt -- receipt.json --base http://127.0.0.1:3157` / `--key <spki>` / tampered copy / unreachable base | 0 / 0 / 1 / 1 | two ✓ lines; two ✓ lines; two ✗ lines; uncaught fetch error, exit 1 |
| 11 | `node /tmp/pbfinal/confirm-hijack.mjs` | 0 | `{"foundByAttacker":true,"confirmStatus":200,"finalStatus":"succeeded","submit":"succeeded"}` |
| 12 | playwright-cli on the app (1440×900 and 375×812) | — | see §6 |
| 13 | playwright-cli `run-code /tmp/pbfinal/docs-qa.js` on docs (8 pages × light/dark × 1440/375 = 32 loads) | 0 | see §7 |
| 14 | `ffprobe` / `ffmpeg volumedetect` on `docs/media/proofbox-demo.mp4` | 0 | see §8 |

## 3. Bugs by severity

Severity is for a **public deploy** unless stated otherwise. In mock mode none of them can harm the host, because no user code runs.

### Critical (submission)
- **C1. No real isolation.** `src/lib/sandbox/vultr-sandbox.ts:32-38`: `create()` always throws (`isMock` → error, no host → error, else `NotImplementedInMockPhase`). No `exec`, `artifacts` or `destroy` is implemented. `grep -rnE "fetch\(|child_process|spawn\(|docker run|runsc" src` finds only two browser-side `fetch` calls (`ReceiptViewer.tsx:20`, `ProofBoxApp.tsx:22`). There is no Dockerfile, compose file, runner daemon or gVisor configuration in the repo. Challenge 1 requires "isolated sandbox execution".
- **C2. No Vultr Serverless Inference.** `src/lib/llm/vultr-inference-llm.ts:21-40`: `plan`/`repair`/`explain`/`verify` all call `notYet()`, which throws. There is no HTTP client code. `getLlm()` (`src/lib/llm/index.ts:10`) uses `MockLlm` unless `MOCK=0`, and with `MOCK=0` every chat would return 502.

### High
- **H1 (new). Anyone can approve another user's human-gated submit.** `src/app/api/runs/[id]/confirm/route.ts:7-16` and `src/lib/orchestrator.ts:34-45` check neither the caller nor any owner. Combined with the open run list (`src/app/api/runs/route.ts:19-28`, which exposes `status: "awaiting_confirm"`), a stranger can list runs, pick the paused one and POST `{stepId, approve:true}`. Repro: `/tmp/pbfinal/confirm-hijack.mjs`. Result: 200, and the submit step **succeeded**. This defeats the "human gate" headline control. In mock mode the submit goes only to a fixture.
- **H2. `/api/chat` and `/api/runs` have no auth or rate limit, a plan can be re-dispatched, and the wait queue is unbounded.** `src/app/api/chat/route.ts:10-28`, `src/app/api/runs/route.ts:11-16`, `src/lib/sandbox/index.ts:19-25` (`waiters` has no bound). Observed: 40/40 chat calls → 200; the same `planId` posted twice → 202 both times with different run ids; 30 runs of one plan → 30×202. `PROOFBOX_DEMO_TOKEN` guards only `/api/sandbox/exec` (`exec/route.ts:31-40`).
- **H3 (new detail of H2). Queued runs starve `/api/sandbox/exec`.** Runs wait for a slot, while ad-hoc exec fails fast (`src/lib/sandbox/index.ts:20-24`, `exec/route.ts:69`). After 12 queued runs: `slots {active 3, queued 9, max 3}`, and an exec from a fresh client → **429** "all 3 sandbox slots are busy". In the first regression pass, 25 execs from 25 distinct XFF addresses all returned 429 for this reason. One unauthenticated client can deny the exec API to everyone.

### Medium
- **M1. Rate limit trusts `X-Forwarded-For`.** `src/lib/rate-limit.ts:19-22`. Fixed XFF: 22 calls → 20×200 + 2×429. Rotating XFF: 25 → 25×200. The probe FAIL reproduces this.
- **M2. Runs are readable by anyone.** `src/app/api/runs/route.ts:19-28` and `src/app/api/runs/[id]/route.ts:7-11`. Observed: 43 runs listed, and `GET /api/runs/:id` → 200 with the full run (plan, user message, files, stdout).

### Low
- **L1. `isForbiddenTarget` gaps** (`src/lib/sandbox/fixtures.ts:60-70`). Calling it directly returns `null` (not forbidden) for `[::7f00:1]` (and `[::127.0.0.1]`, which normalises to it), `198.18.0.1`, `198.19.255.1`, `224.0.0.1`, `239.255.255.250`, `240.0.0.1`, `255.255.255.255` and `[64:ff9b::7f00:1]` (NAT64 to loopback). Correctly blocked: `[::ffff:7f00:1]`, `2130706433`, `0x7f000001`, `[::]` and metadata. Today the allowlist still stops all of these (probe: "not in egress allowlist"). DNS rebinding: there is no post-resolution check anywhere, but the mock never resolves DNS, so this **cannot be tested in mock** and has to be designed into the real egress proxy.
- **L2. The host-side `Function()` in the mock gets Python semantics wrong.** `src/lib/sandbox/mock-sandbox.ts:33-43`. The regex limits input to digits and operators (≤ 80 chars), so no code injection was found, but `//` is rewritten to `/` and JS `%` is used. Observed `print(7//2)` → `3.5` (Python: `3`), `print(-7%3)` → `-1` (Python: `2`), `print(0.1+0.2)` → `0.30000000000000004` (Python: same), `print(1/0)` → `<mock: not evaluated: 1/0>` (Python: ZeroDivisionError). A signed receipt can therefore hold a wrong "result", which matters for a product called Prove-It.
- **L3. Simulated stderr is not labelled.** `mock-sandbox.ts:116,128,130,233,241` produce text such as "not permitted (no capabilities, seccomp profile)", "exceeds cgroup cap", "OOM-killed", "process group killed". `ReceiptViewer.tsx:149` labels the box just "stderr". Observed: `labelled: false`. The badge and the amber note say "simulated", but a cropped stderr box does not. The video frame at 1:28 shows this stderr box, with the "sandbox simulated" title visible.
- **L4. `verify-receipt` default and error handling.** `scripts/verify-receipt.mjs:27`: `--base` defaults to `http://localhost:3000`, so it may fetch a key from an unrelated service. It was not run against 3000, which is off-limits. Also `:28`: an unreachable base throws uncaught and exits **1**, the same code as "invalid receipt" (the header says 2 = usage error). And a key fetched from the same server is not independent trust.
- **L5. Signing key failure is lazy.** `src/lib/sandbox/signing.ts:19-31`. The key is loaded on the first seal, not at startup. A malformed `RECEIPT_SIGNING_KEY` throws `asn1 … not enough data`, and an RSA key throws "must be an Ed25519 key", only when the first receipt is sealed (after `destroy()`), so the run aborts instead of the server refusing to start. Without the variable, the key changes on every process start (observed), so receipts sealed before a restart stop verifying against `/api/receipts/public-key`.
- **L6. Limits are in memory and single-process.** `src/lib/rate-limit.ts:3`, `src/lib/sandbox/index.ts:18-19`, `src/lib/store.ts`. This is acceptable for one VM. It is not re-tested beyond reading the code.

## 4. Previous findings: status

| Id | Finding | Repro | Where | Result on 2026-11-07 |
|---|---|---|---|---|
| a | chat/runs: no auth or rate limit, unbounded queue, re-dispatch | `regress.mjs` | `chat/route.ts:10`, `runs/route.ts:11-16`, `sandbox/index.ts:19-25` | **Still open.** 40/40 chat 200; re-dispatch 202+202; 30 runs 202; queue 9 waiting; exec starved (429). |
| b | XFF rate-limit bypass | probe + `regress2.mjs` | `rate-limit.ts:19-22` | **Still open.** Rotating 25/25 × 200; fixed 20×200 + 2×429. |
| c | Unauthenticated GET of runs | `regress.mjs` | `runs/route.ts:19-28`, `runs/[id]/route.ts:7-11` | **Still open**, and it is the enabler for **H1** (confirm hijack). |
| d | `isForbiddenTarget` gaps; DNS rebinding | `forbidden.ts` | `fixtures.ts:60-70` | **Still open.** `[::7f00:1]`, 198.18/15, 224/4, 240/4 and 255.255.255.255 return null. Also new: `[64:ff9b::7f00:1]`. Rebinding: untestable in mock. |
| e | Signing key persistence | `signing.ts` | `signing.ts:19-31` | **Works as documented.** No key → new keyId per process, `ephemeral:true`. Key set → stable keyId, `ephemeral:false`. New: bad key fails late (L5). |
| f | Host `Function()` arithmetic | `regress2.mjs` | `mock-sandbox.ts:33-43` | **Still present.** No injection found within the regex. New: Python semantics are wrong (L2). |
| g | Simulated stderr labelling | `regress2.mjs` | `mock-sandbox.ts:128,233`, `ReceiptViewer.tsx:149` | **Still open** (`labelled:false`). |
| h | verify-receipt default `--base` | code + runs | `verify-receipt.mjs:27` | **Still open.** Explicit `--base`/`--key` work; tampered copy → exit 1. New: unreachable base → uncaught, exit 1. |

## 5. Real sandbox and LLM? (evidence)

- **Sandbox: not real.** `getSandboxProvider()` (`src/lib/sandbox/index.ts:38-41`) returns `MockSandbox` unless `MOCK=0`. `MockSandbox` pattern-matches the code and never executes it (`mock-sandbox.ts:1-3`, `225-250`). `VultrSandbox` is an interface stub that throws (`vultr-sandbox.ts:32-38`). There is no Docker, gVisor or Vultr code and no infrastructure file in the repo.
- **LLM: not real.** `VultrInferenceLlm` is a stub that throws in every method (`vultr-inference-llm.ts:21-40`). `MockLlm` is a template planner.
- What **is** real code: plan validation, server-inserted probes, the forced confirm, the egress intersection and clamp, env redaction, output scrubbing, receipt canonicalisation with sha256 + Ed25519, and the verdict logic. All are covered by the 47 unit tests and the 80 probe passes.

## 6. Browser QA of the app (playwright-cli, Chromium)

| Check | 1440×900 | 375×812 |
|---|---|---|
| Prove-It Python → Dispatch to sandbox → | "Run succeeded: 3/3 steps succeeded", badge `CONTAINED (SIMULATED)` | same, "Run succeeded: 3/3" |
| Receipt **verify** | "✓ sha256 recomputed in your browser · ✓ Ed25519 signature valid — key 5148e499… (ephemeral demo key)" | not repeated |
| CSV Analyst | "Run succeeded: 2/2", `step.retry` in the timeline, `revenue_usd`, exfil blocked | not repeated |
| Research with Receipts: **Deny** | dialog "Human confirmation required", focus on **Deny** (`[active]`), then "Run succeeded: 4/5", submit skipped, "Nothing was submitted" | dialog 19–356 px wide, Deny and Approve buttons on screen (y=675 of 812); Deny → 4/5 |
| Research: **Run again → Approve submit** | "202 captured by fixture", "Run succeeded: 5/5" | not repeated |
| Horizontal overflow | — | `scrollWidth` 375 before and after a run |
| Console | 0 errors, 0 warnings | 0 errors, 0 warnings |

Screenshot of the confirm gate: `docs/reviews/media/2026-11-07-confirm-gate-1440.png`. No layout bug was found, so no other screenshot was saved.
Note: after a Deny, the run status is "succeeded" (4/5). This is defensible, but a judge may read "succeeded" as "the submit happened".

## 7. Docs check (docs/ served alone on 3158)

- 8 pages (6 workdocs pages plus `diagrams.html` and `workmap.html`) × light/dark × 1440/375 = 32 loads. Every load had `scrollWidth` equal to the viewport, exactly one `h1`, the expected background per scheme, no "Loading…/TODO/lorem" text, no request outside `127.0.0.1:3158`, and no `.md`/`.json`/README request (server log: 0). Console errors: 0, except one `favicon.ico` 404 on the first page load (acceptable). Link check of every `<a href>` on all 8 pages, including `#anchors`: 0 broken.
- Diagram files mention `https://github.com/JetBrains/JetBrainsMono` only in a comment ("Upstream: …"). No request was made.
- **Claims vs code:** the counts (47/47, 29/29, 80 pass / 1 fail), the endpoints and status codes, the env names and defaults (`SANDBOX_EXEC_PER_MINUTE` 20, `SANDBOX_MAX_CONCURRENT` 3, ceilings 30000 ms / 1024 MiB), the file:line references in the Security threat table, the stub status of Vultr, and the "simulated" labels all match what I ran and read. The Security "Known gaps" table (9 items) is accurate but **incomplete**: it lacks **H1** (confirm by anyone), **H3** (queued runs starve exec, 429 for all), **L2** (wrong Python results that still get signed) and L5 (bad key fails late). Gap 1 says "25/25 chat calls"; I observed 40/40 (same conclusion).
- **Setup reproducibility:** `npm run typecheck`, `npm test`, `npm run build`, start on another port, smoke, probe and `verify-receipt --base` all reproduced as written (§2). `npm install` was not re-run because `node_modules` is present.
- **Demo script vs UI:** every quoted label exists in the UI exactly: "Prove-It Python", "Dispatch to sandbox →", "verify", "download receipt.json", "Containment probe" / "containment probe · policy", "Resource cap probe", "CSV Analyst", "Research with Receipts", "Human confirmation required", "Deny", "Approve submit", "Run again", "Run succeeded: 3/3 / 2/2 / 4/5 / 5/5", "✓ sha256 recomputed in your browser · ✓ Ed25519 signature valid", "(ephemeral demo key)". The receipt download file name (`receipt-<sandboxId>.json`) was not checked in the browser.

## 8. Video

- `docs/media/proofbox-demo.mp4`: H.264 1920×1080 plus an AAC audio track, **156.8 s** (the docs say 2:37, which matches), 10.99 MB. Audio mean −19.8 dB, max −1.2 dB, so it is not silent. Captions: `.srt` with 37 cues and a `.vtt`; there is a poster image. `video/out/raw.mp4` has the same length (14.06 MB).
- Containment moment (≈1:19–1:33, "Now the containment moment… All blocked… killed at the memory cap"): a frame at 1:28 shows the live app with the title "Containment probe · live app · mock mode · sandbox simulated" and the amber "Simulated by mock: no container or VM ran" note. At 0:50 there is a "MOCK MODE · no Vultr calls / what is simulated" slide. **This is an honest mock containment moment, not a real one.** It does not show a host terminal or a real container.
- Only 3 frames and the captions were inspected. I did not watch the full video or listen to the audio for quality.

## 9. Submission evidence

The lablab page was fetched read-only (URL from `README.md:5`, which redirects to lablab.build, HTTP 200). Its "Submission expectations" for Challenge 1: GitHub repository with setup and documentation, Vultr VM backend deployment, public demo URL, recorded demo video, clear architecture and use-case explanation, one containment moment in the video. Required form items: cover image, video presentation, slide presentation, public GitHub repository, application URL, Vultr usage in the README. Challenge 1 also requires Vultr Serverless Inference and isolated sandbox execution.

| Item | Status | Evidence |
|---|---|---|
| Public GitHub repo URL | **Definitely absent from this workspace.** The folder is not a git repo (only `.gitignore`), and no project repo URL appears in any file. A repo elsewhere: no evidence found. | grep of the repo: only lablab and dependency URLs |
| Public demo URL | **No evidence found.** No URL in the repo; the README says "planned — not deployed" | `README.md` "Vultr services used" |
| Real Vultr VM | **Definitely absent from the code.** No deploy config. Whether an account or VM exists: no evidence found | `README.md` status "none yet" |
| Real Vultr Serverless Inference | **Definitely absent:** the provider is a stub that throws | `vultr-inference-llm.ts:21-40` |
| Isolated sandbox | **Definitely absent:** mock only | §5 |
| Video | **Present:** 156.8 s, with audio and captions; the containment moment is simulated | §8 |
| Architecture | **Present:** `docs/diagrams/architecture-current.html` (plus a "vultr-planned" version) and the README section | docs QA |
| Slides | **No evidence found** (no pdf, pptx, key or `*slide*` file) | `find` |
| Cover image | **No evidence found** (only `docs/media/proofbox-demo-poster.jpg`, the video poster, and `public/favicon.svg`) | `find` |
| README explains Vultr usage | **Present, as planned.** It honestly says none is used yet | `README.md` |

### Exact blockers before submitting (deadline 2026-11-08 per PLAN.md)
1. Implement a real sandbox: a runner on a Vultr VM using Docker (+ gVisor) that implements `create`/`exec`/`artifacts`/`destroy` in `VultrSandbox`.
2. Implement `VultrInferenceLlm` against `https://api.vultrinference.com/v1/chat/completions`, then switch to `MOCK=0`.
3. Deploy the web app and backend on a Vultr VM and get a public demo URL.
4. Before going public, fix at least H1, H2/H3 and M1 (set `PROOFBOX_DEMO_TOKEN` and `RECEIPT_SIGNING_KEY`), and preferably M2.
5. Create a public GitHub repo (the user's decision; not done here) and update the README "Vultr services used" section with the real plan, region and model.
6. Re-record the containment moment against the real sandbox (the docs already plan "with a host terminal beside the browser").
7. Make the slides and cover image.

## 10. Not tested, and why

- A real sandbox, Docker or gVisor: none exists, and running containers is out of scope.
- `MOCK=0` mode and Vultr calls: forbidden (paid/network), and the providers are stubs anyway.
- DNS rebinding: the mock resolves no DNS.
- `verify-receipt` with the default base: it would hit port 3000, which is off-limits.
- `PROOFBOX_DEMO_TOKEN` enforcement on a live server: the server ran without a token. Coverage was judged from the code (only the exec route).
- `npm install` from scratch, and `npm start` on the default port 3000: off-limits port; an equivalent `next start -p 3157` was used.
- Docs with JS disabled, over `file://`, and under reduced motion: not run in this pass.
- Browsers other than Chromium; the in-browser receipt download (file name and content).
- The full video playback, audio quality, and frames other than 0:31, 0:50 and 1:28.
- Whether a GitHub repo, Vultr account, VM or lablab draft exists outside this workspace: no access, and no logins by rule.
