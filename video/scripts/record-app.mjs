// Record the live mock app for the demo video.
// Usage (app running in mock mode): node scripts/record-app.mjs http://127.0.0.1:3171
// Writes public/clips/app-raw.webm and public/clips/marks.json (segment start/end in seconds).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const outDir = path.resolve("public/clips");
const tmpDir = path.join(outDir, "tmp");
fs.mkdirSync(tmpDir, { recursive: true });

const VIEW = { width: 1440, height: 810 };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({
  viewport: VIEW,
  deviceScaleFactor: 1,
  recordVideo: { dir: tmpDir, size: VIEW },
});
// Visible cursor: headless recordings have no pointer.
await context.addInitScript(() => {
  window.addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.id = "__cursor";
    Object.assign(dot.style, {
      position: "fixed", left: "0px", top: "0px", width: "18px", height: "18px", marginLeft: "-9px", marginTop: "-9px",
      borderRadius: "50%", background: "rgba(255,255,255,0.85)", border: "2px solid #34d399", zIndex: "2147483647",
      pointerEvents: "none", boxShadow: "0 0 0 6px rgba(52,211,153,0.25)", transition: "transform 120ms",
    });
    document.body.appendChild(dot);
    window.addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
    window.addEventListener("mousedown", () => (dot.style.transform = "scale(0.7)"), true);
    window.addEventListener("mouseup", () => (dot.style.transform = "scale(1)"), true);
  });
});

const page = await context.newPage();
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const sleep = (ms) => page.waitForTimeout(ms);
const marks = {};
let last = { x: VIEW.width / 2, y: VIEW.height / 2 };

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error("no box");
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  last = { x, y };
}
async function click(locator, pause = 350) {
  await moveTo(locator);
  await sleep(pause);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
const preset = (name) => page.locator("button", { hasText: name }).first();
const dispatchBtn = () => page.getByRole("button", { name: /Dispatch to sandbox|Run again/ });
const stepCard = (title) => page.locator("ol li button", { hasText: title }).first();
const chat = (re) => page.locator("ol[aria-live] li", { hasText: re }).last();

await page.goto(base, { waitUntil: "networkidle" });
await page.getByText("MOCK MODE · no Vultr calls").waitFor();
await page.mouse.move(last.x, last.y);
await sleep(1500);

// --- prove
marks.prove = { start: now() };
await click(preset("Prove-It Python"));
await page.getByRole("button", { name: /Dispatch to sandbox/ }).waitFor();
await sleep(1600);
await click(dispatchBtn());
await chat(/Run succeeded/).waitFor({ timeout: 60000 });
await sleep(1200);
await click(stepCard("Run code in sandbox"));
await sleep(2200);
await click(page.getByRole("button", { name: "verify", exact: true }));
await page.getByText(/Ed25519 signature valid/).waitFor({ timeout: 20000 });
await sleep(4000);
marks.prove.end = now();

// --- contain
marks.contain = { start: now() };
await click(stepCard("Containment probe"));
await sleep(5500);
const receipt = page.locator("section", { hasText: "Receipt" }).last();
await moveTo(receipt);
await page.mouse.wheel(0, 260);
await sleep(3000);
await click(stepCard("Resource cap probe"));
await sleep(5500);
marks.contain.end = now();

// --- csv
marks.csv = { start: now() };
await click(preset("CSV Analyst"));
await page.getByRole("button", { name: /Dispatch to sandbox/ }).waitFor();
await sleep(1400);
await click(dispatchBtn());
await chat(/Run succeeded/).waitFor({ timeout: 60000 });
await sleep(800);
await click(stepCard("Write + run analysis script"));
await sleep(4500);
await click(stepCard("Exfiltration probe"));
await sleep(3500);
marks.csv.end = now();

// --- gate
marks.gate = { start: now() };
await click(preset("Research with Receipts"));
await page.getByRole("button", { name: /Dispatch to sandbox/ }).waitFor();
await sleep(1400);
await click(dispatchBtn());
await page.getByRole("button", { name: "Deny" }).waitFor({ timeout: 60000 });
await sleep(2600);
await click(page.getByRole("button", { name: "Deny" }));
await chat(/4\/5/).waitFor({ timeout: 60000 });
await sleep(1800);
await click(dispatchBtn());
await page.getByRole("button", { name: "Approve submit" }).waitFor({ timeout: 60000 });
await sleep(1600);
await click(page.getByRole("button", { name: "Approve submit" }));
await chat(/5\/5/).waitFor({ timeout: 60000 });
await sleep(1200);
await click(stepCard("Submit form"));
await sleep(3500);
marks.gate.end = now();

const video = page.video();
await context.close();
await browser.close();
const raw = path.join(outDir, "app-raw.webm");
fs.renameSync(await video.path(), raw);
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.writeFileSync(path.join(outDir, "marks.json"), JSON.stringify(marks, null, 2) + "\n");
console.log(JSON.stringify(marks));
