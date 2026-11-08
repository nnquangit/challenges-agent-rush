// Browser fixtures for MockSandbox Pattern B. Nothing here touches the network:
// pages are canned models, screenshots are SVGs rendered from those models.

import { classifyHost, type AddressClass } from "./addresses";

export interface FixturePage {
  host: string;
  title: string;
  heading: string;
  lines: string[];
  /** Evidence boxes a vision check can "see". */
  evidence: { label: string; text: string }[];
  form?: { selector: string; label: string }[];
  submitLabel?: string;
}

const PRICING: FixturePage = {
  host: "shop.example.com",
  title: "Acme Cloud — Pricing",
  heading: "Simple pricing for every team",
  lines: ["All plans include sandboxed builds and 99.9% uptime."],
  evidence: [
    { label: "Starter", text: "$9 / month" },
    { label: "Pro", text: "$29 / month" },
    { label: "Team", text: "$79 / month" },
  ],
  form: [
    { selector: "#name", label: "Name" },
    { selector: "#email", label: "Work email" },
    { selector: "#message", label: "Message" },
  ],
  submitLabel: "Send to sales",
};

const DOCS: FixturePage = {
  host: "docs.example.com",
  title: "Example Docs — Changelog",
  heading: "Changelog",
  lines: ["v2.4.0 — 2026-10-30", "Sandbox runners now default to deny-all egress."],
  evidence: [{ label: "Latest release", text: "v2.4.0 (2026-10-30)" }],
};

const FIXTURES: Record<string, FixturePage> = {
  "shop.example.com": PRICING,
  "example.com": PRICING,
  "docs.example.com": DOCS,
};

export function fixtureFor(host: string): FixturePage {
  return (
    FIXTURES[host] ?? {
      host,
      title: `${host} (fixture)`,
      heading: `Fixture page for ${host}`,
      lines: ["MockSandbox serves a canned page for allowlisted hosts.", "No real request left the sandbox."],
      evidence: [{ label: "Host", text: host }],
    }
  );
}

const REASONS: Record<Exclude<AddressClass, null>, string> = {
  metadata: "cloud metadata endpoint blocked",
  "link-local": "link-local blocked",
  loopback: "loopback (host) blocked",
  private: "private network blocked",
  reserved: "reserved address range blocked",
  multicast: "multicast/broadcast blocked",
};

/**
 * Hosts that must never be reachable from a sandbox, whatever the allowlist says.
 * Literal IPs and well-known names only (src/lib/sandbox/addresses.ts); names are
 * not resolved, so DNS rebinding must be handled by the real egress proxy.
 */
export function isForbiddenTarget(url: URL): string | null {
  if (url.protocol === "file:") return "file:// is not mounted in the sandbox";
  if (!/^https?:$/.test(url.protocol)) return `scheme ${url.protocol} blocked`;
  const c = classifyHost(url.hostname);
  return c ? REASONS[c] : null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface ShotState {
  url: string;
  page: FixturePage;
  highlight?: string; // evidence label to box
  filled?: Record<string, string>;
  banner?: { tone: "ok" | "warn" | "block"; text: string };
}

/** Render a fake 1280×800 screenshot as an SVG data URL. */
export function renderScreenshot(s: ShotState): string {
  const W = 1280;
  const H = 800;
  const tone = { ok: "#059669", warn: "#d97706", block: "#dc2626" };
  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#f8fafc"/>`);
  // browser chrome
  parts.push(`<rect width="${W}" height="64" fill="#e2e8f0"/>`);
  parts.push(`<circle cx="28" cy="32" r="7" fill="#f87171"/><circle cx="52" cy="32" r="7" fill="#fbbf24"/><circle cx="76" cy="32" r="7" fill="#34d399"/>`);
  parts.push(`<rect x="110" y="16" width="1000" height="32" rx="16" fill="#fff" stroke="#cbd5e1"/>`);
  parts.push(`<text x="132" y="38" font-size="16" fill="#334155" font-family="ui-monospace,monospace">🔒 ${esc(s.url)}</text>`);
  parts.push(`<rect x="1124" y="16" width="140" height="32" rx="8" fill="#0f172a"/><text x="1194" y="37" font-size="13" fill="#a7f3d0" text-anchor="middle" font-family="ui-monospace,monospace">sandboxed</text>`);
  // page
  parts.push(`<text x="80" y="140" font-size="40" font-weight="700" fill="#0f172a" font-family="system-ui,sans-serif">${esc(s.page.heading)}</text>`);
  s.page.lines.forEach((l, i) =>
    parts.push(`<text x="80" y="${185 + i * 28}" font-size="18" fill="#475569" font-family="system-ui,sans-serif">${esc(l)}</text>`),
  );
  const top = 185 + s.page.lines.length * 28 + 20;
  s.page.evidence.forEach((e, i) => {
    const x = 80 + i * 300;
    const hl = s.highlight && e.label.toLowerCase() === s.highlight.toLowerCase();
    parts.push(`<rect x="${x}" y="${top}" width="270" height="150" rx="14" fill="#fff" stroke="${hl ? "#ef4444" : "#cbd5e1"}" stroke-width="${hl ? 5 : 1.5}"/>`);
    parts.push(`<text x="${x + 24}" y="${top + 50}" font-size="22" font-weight="600" fill="#0f172a" font-family="system-ui,sans-serif">${esc(e.label)}</text>`);
    parts.push(`<text x="${x + 24}" y="${top + 100}" font-size="30" font-weight="700" fill="#4f46e5" font-family="system-ui,sans-serif">${esc(e.text)}</text>`);
    if (hl) parts.push(`<text x="${x}" y="${top - 10}" font-size="15" fill="#ef4444" font-family="ui-monospace,monospace">evidence ▼</text>`);
  });
  if (s.page.form) {
    const fy = top + 190;
    parts.push(`<text x="80" y="${fy}" font-size="22" font-weight="600" fill="#0f172a" font-family="system-ui,sans-serif">Contact sales</text>`);
    s.page.form.forEach((f, i) => {
      const y = fy + 20 + i * 62;
      const val = s.filled?.[f.selector];
      parts.push(`<text x="80" y="${y + 30}" font-size="15" fill="#475569" font-family="system-ui,sans-serif">${esc(f.label)}</text>`);
      parts.push(`<rect x="220" y="${y + 8}" width="520" height="38" rx="8" fill="#fff" stroke="${val ? "#6366f1" : "#cbd5e1"}"/>`);
      if (val) parts.push(`<text x="234" y="${y + 33}" font-size="15" fill="#0f172a" font-family="system-ui,sans-serif">${esc(val.slice(0, 60))}</text>`);
    });
    const by = fy + 20 + s.page.form.length * 62 + 10;
    parts.push(`<rect x="220" y="${by}" width="200" height="44" rx="10" fill="#4f46e5"/><text x="320" y="${by + 28}" font-size="16" fill="#fff" text-anchor="middle" font-family="system-ui,sans-serif">${esc(s.page.submitLabel ?? "Submit")}</text>`);
  }
  if (s.banner) {
    parts.push(`<rect x="0" y="${H - 64}" width="${W}" height="64" fill="${tone[s.banner.tone]}"/>`);
    parts.push(`<text x="40" y="${H - 24}" font-size="20" fill="#fff" font-family="ui-monospace,monospace">${esc(s.banner.text)}</text>`);
  }
  parts.push(`<text x="${W - 20}" y="${H - (s.banner ? 76 : 14)}" font-size="12" fill="#94a3b8" text-anchor="end" font-family="ui-monospace,monospace">ProofBox MockSandbox fixture · not a real capture</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function renderBlockedScreenshot(url: string, reason: string): string {
  return renderScreenshot({
    url,
    page: {
      host: "blocked",
      title: "Blocked",
      heading: "Navigation blocked by sandbox egress policy",
      lines: [reason, "The request never left the sandbox network namespace."],
      evidence: [],
    },
    banner: { tone: "block", text: `BLOCKED · ${reason}` },
  });
}
