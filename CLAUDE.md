# ProofBox (Vultr Agent Rush)

Đọc `PLAN.md` trước khi làm. Giai đoạn này **mock-only**: không gọi Vultr, không đăng ký lablab, không ghi secret.

## Stack

Next.js App Router, TypeScript, Tailwind. `SandboxProvider` + `MockSandbox` + stub `VultrSandbox`. `LlmProvider` + `MockLlm` + stub `VultrInferenceLlm`.

Kiểm tra: `npm run typecheck`, `npm test`, `npm run build`, `npm run smoke -- http://localhost:3000`.

## Tài liệu cho người đọc (skill workdocs)

- Sáu trang HTML tĩnh tiếng Anh trong `docs/`: `index.html`, `setup.html`, `how-it-works.html`, `security.html`, `api.html`, `demo.html`. Nội dung viết thẳng vào HTML (không đọc `.md`/`.json` lúc mở), CSS/JS chung ở `docs/assets/workdocs.{css,js}` chỉ lo trình bày.
- Sửa nội dung = sửa trong các marker `<!-- workdocs:begin id=… -->`; code đổi → chạy lại workdocs cho mục bị ảnh hưởng và cập nhật ngày ở footer.
- Sơ đồ kiến trúc: `docs/diagrams/architecture-current.html` (Archify), nguồn `.archify/architecture-proofbox-current-20261107-220549/candidate.json`. Đổi kiến trúc → sinh lại sơ đồ.
- Tài liệu cho agent giữ markdown (`PLAN.md`, file này).

## Bản đồ công việc (skill workmap)

- **Mọi việc đều lên bản đồ** (`docs/workmap.html`, nguồn `docs/shared/workmap.md`), chỉ qua CLI:
  - `python3 scripts/workmap.py find "<text>"`
  - `python3 scripts/workmap.py add "<Epic>/<Feature>" "<Việc>" -s doing -o <agent>`
  - `python3 scripts/workmap.py set <id> done -n "…"` (huỷ: `cancel`, tạm dừng: `pause`)
  - Xem nhanh: `python3 scripts/workmap.py show -d 2`
- Không sửa tay `docs/workmap.html`. Chưa cập nhật bản đồ = việc chưa xong.
