# ProofBox — kế hoạch Vultr Agent Rush (mock-first)

Hackathon: [Vultr: Agent Rush](https://lablab.ai/ai-hackathons/vultr-hackathon) (lablab.build)  
Online build: 3–8/11/2026 · Hạn nộp judging: **8/11/2026** trên lablab.ai  
Thể loại chọn: **Challenge 1 — Blast Radius Zero**  
Nguyên tắc giai đoạn này: **không gọi Vultr/lablab thật**. Mọi LLM, sandbox, browser, VM đều **mock API**. Chưa đăng ký tài khoản.

## Vì sao Challenge 1

Ban tổ chức muốn agent web làm việc thật — viết/chạy code hoặc điều khiển browser — nhưng mọi hành động nằm trong sandbox cô lập trên Vultr. Hệ thống là lớp điều khiển trung tâm: lập kế hoạch → dispatch vào môi trường cô lập → trả output có thể kiểm chứng. Chat-only không đạt. Challenge 1 bắt buộc:

- Vultr VM backend + web app deploy trên Vultr (giai đoạn sau)
- Vultr Serverless Inference cho mọi lời gọi LLM của agent (`https://api.vultrinference.com/v1`, OpenAI-compatible)
- Isolated execution (Docker được khuyến nghị; OpenSandbox / gVisor / E2B / Microsandbox là ví dụ)
- Không dùng Vultr GPU ở event này
- Trong video demo phải có **một containment moment** (chứng minh lệnh/code không chạy trên host)

Challenge 2 (Future of Work / enterprise workflow) bỏ qua ở bản này — không khớp skill sandbox code/browser bằng Challenge 1.

## Sản phẩm: ProofBox

Web app điều khiển agent theo containment-first:

1. User giao việc bằng tiếng Anh (sau có thể thêm tiếng Việt ở UI).
2. Planner (LLM) lập multi-step plan.
3. Mỗi bước được dispatch vào **sandbox provider** (hiện tại `MockSandbox`).
4. Sandbox trả artifact kiểm chứng được: stdout/stderr, exit code, file diff, screenshot giả, log isolation.
5. UI hiện plan, từng run, receipt, và cảnh “containment”: process không đụng host, secret bị che, có time/memory cap, môi trường bị destroy sau task.

Hai execution pattern (cả hai đều mock):

- **Pattern A — Sandboxed code execution:** user hỏi → model “viết” code → runner giả lập chạy trong container → trả output → model giải thích. Lỗi giả lập được đưa lại để retry.
- **Pattern B — Sandboxed browser use:** user đưa goal → planner → Playwright giả trong container → trả screenshot fixture → “vision” mock xác minh → **human confirm** trước hành động cuối.

Use case demo (chọn hướng ban tổ chức gợi ý):

- **Prove-It runner:** “Chạy đoạn Python này, chứng minh kết quả và cho tôi receipt.”
- **CSV Analyst:** upload/paste CSV mẫu → agent viết script phân tích trong sandbox → bảng + chart data giả lập.
- **Research with Receipts (browser mock):** “Mở trang X, chụp evidence, đừng submit form” — screenshot fixture + log “navigation stayed in sandbox.”

## Kiến trúc mock (giai đoạn hiện tại)

```
Browser UI (Next.js)
    → POST /api/chat        mock planner (không gọi api.vultrinference.com)
    → POST /api/runs        tạo run + các step
    → POST /api/sandbox/exec
           SandboxProvider
             ├─ MockSandbox        ← đang dùng: fixture + delay + limits
             └─ VultrSandbox       ← stub interface, chưa implement mạng thật
    → GET  /api/runs/:id     receipt: logs, artifacts, isolation report
```

Hợp đồng `SandboxProvider` (để sau cắm Vultr mà không đổi UI):

- `create(taskId)` / `exec({ cmd | browserGoal })` / `artifacts()` / `destroy()`
- Resource limits: timeout, memory cap (mock clock + từ chối nếu vượt)
- Secret hygiene: mọi env key dạng `API_KEY|TOKEN|SECRET` bị redact trước khi “vào” sandbox
- Lifecycle: `destroy()` luôn chạy trong `finally`
- Isolation report: `{ hostTouched: false, networkPolicy, pidNamespace: "mock" }`

Mock LLM:

- File `src/lib/mock-llm.ts` hoặc tương đương: trả plan JSON cố định theo intent (code vs browser vs csv)
- Interface `LlmProvider` với `MockLlm` và stub `VultrInferenceLlm` (base URL + model từ env, **không gọi** khi `MOCK=1`)

Dữ liệu: in-memory store (đủ cho demo local). Không cần DB.

## Việc cố ý chưa làm (chờ anh duyệt tài khoản)

- Đăng ký lablab.ai / Discord LabLab
- Tạo tài khoản Vultr (email chưa từng dùng Vultr) và claim $200 credit
- Gọi `api.vultrinference.com` hoặc tạo VM / Docker thật trên Vultr
- Deploy public URL trên Vultr
- Nộp bài trên lablab

Khi anh xong tài khoản, impl `VultrSandbox` + `VultrInferenceLlm` và deploy — không đổi API UI.

## Nộp bài (nhắc để không lệch)

Bắt buộc trên lablab.ai: title, mô tả ngắn/dài, tags, cover, video, slides, GitHub public, URL demo. README phải giải thích dịch vụ Vultr dùng (VM backend, Serverless Inference, sandbox). Challenge 1: video có containment moment. Showcase Vultr Community là optional.

Giải: $5k+$3k credit / $3k+$1k / $1k+$1k. Tổng cash $9k + $5k credit. Onsite SLC 8/11 không tính (không đi).

Chấm: Application of Technology, Presentation, Business Value, Originality.

## Việc cần làm ngay (Claude / agent trong repo này)

1. Scaffold app web production-style (Next.js + TypeScript + Tailwind), MIT license, README.
2. Implement mock planner, mock sandbox (code + browser), receipts, human-confirm cho browser final action.
3. UI: chat/plan board + run timeline + isolation badge + artifact viewer (kể cả ảnh fixture).
4. `.env.example` với `MOCK=1`, stub `VULTR_INFERENCE_API_KEY`, không commit secret.
5. Docs theo **docs-workflow**:
   - Chạy `bash ~/.claude/skills/docs-workflow/scripts/init.sh` trên repo nếu chưa init.
   - Mọi việc ghi lên bản đồ bằng `python3 scripts/workmap.py` (không sửa tay `docs/workmap.html`).
   - Có `docs/index.html`, `docs/how-it-works.html`, `docs/workmap.html`.
6. Không push, không tạo repo GitHub remote, không signup dịch vụ ngoài.

Xong giai đoạn mock: `npm install && npm run dev` chạy được end-to-end với fixture, không cần mạng tới Vultr.
