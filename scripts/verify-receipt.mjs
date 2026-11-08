// Verify a ProofBox receipt offline: recompute the canonical payload, check the
// sha256, then the Ed25519 signature against a public key you choose.
//   node scripts/verify-receipt.mjs receipt.json --key <base64 spki>        (pinned key: independent trust)
//   node scripts/verify-receipt.mjs receipt.json --base http://127.0.0.1:3000 [--key-id <id>]
// There is no default --base: the key source must be explicit. A key fetched
// from the same server that issued the receipt proves integrity, not
// independence — pin the key (or its --key-id) you obtained earlier for that.
// Exit codes:
//   0 = valid (sha256 and signature both check out)
//   1 = INVALID receipt (hash or signature mismatch, or key id differs from --key-id)
//   2 = usage error (bad arguments, unreadable or non-JSON receipt file)
//   3 = key unavailable (--base unreachable, bad response, or malformed --key) — the receipt was NOT judged

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { receiptPayload } from "../src/lib/receipt-canonical.ts";

const EXIT = { valid: 0, invalid: 1, usage: 2, key: 3 };
const usage = "usage: node scripts/verify-receipt.mjs receipt.json (--key <base64 spki> | --base <url>) [--key-id <expected keyId>]";
const die = (code, msg) => {
  console.error(msg);
  process.exit(code);
};

const args = process.argv.slice(2);
const VALUED = new Set(["--key", "--base", "--key-id"]);
const opts = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUED.has(a)) {
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) die(EXIT.usage, `${a} needs a value\n${usage}`);
    opts[a] = args[++i];
  } else if (a.startsWith("--")) die(EXIT.usage, `unknown option ${a}\n${usage}`);
  else positional.push(a);
}
if (positional.length !== 1) die(EXIT.usage, usage);
if (!opts["--key"] && !opts["--base"]) die(EXIT.usage, `no key source: pass --key <base64 spki> or --base <url> (there is no default)\n${usage}`);
if (opts["--key"] && opts["--base"]) die(EXIT.usage, `pass either --key or --base, not both\n${usage}`);

let receipt;
try {
  receipt = JSON.parse(readFileSync(positional[0], "utf8"));
} catch (e) {
  die(EXIT.usage, `cannot read receipt ${positional[0]}: ${e.code ?? e.message}`);
}
if (receipt && receipt.receipt) receipt = receipt.receipt; // accept the raw /api/sandbox/exec response too
if (!receipt || typeof receipt !== "object" || typeof receipt.sha256 !== "string") die(EXIT.usage, "file is not a ProofBox receipt (no sha256 field)");

let spki = opts["--key"];
let source = "pinned --key";
if (!spki) {
  let base;
  try {
    base = new URL(opts["--base"]);
    if (!/^https?:$/.test(base.protocol)) throw new Error("scheme");
  } catch {
    die(EXIT.usage, `--base must be an http(s) URL, got ${opts["--base"]}`);
  }
  const url = new URL("/api/receipts/public-key", base);
  let info;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
    if (typeof info?.spki !== "string") throw new Error("response has no spki");
  } catch (e) {
    die(EXIT.key, `key unavailable: could not get ${url.href} (${e.cause?.code ?? (e.name === "TimeoutError" ? "timeout" : e.message)}) — receipt not judged`);
  }
  spki = info.spki;
  source = `${base.origin} (same-server key: integrity only, not independent trust)`;
  if (info.keyId !== receipt.signature?.keyId) console.warn(`! server keyId ${info.keyId} ≠ receipt keyId ${receipt.signature?.keyId} (server restarted with an ephemeral key, or a different server?)`);
}

let key;
try {
  key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`not an Ed25519 key (${key.asymmetricKeyType})`);
} catch (e) {
  die(EXIT.key, `key unavailable: malformed public key from ${source}: ${e.message} — receipt not judged`);
}
const keyId = createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);

const payload = Buffer.from(receiptPayload(receipt), "utf8");
const hashOk = createHash("sha256").update(payload).digest("hex") === receipt.sha256;
let sigOk = false;
try {
  sigOk = verify(null, payload, key, Buffer.from(receipt.signature?.value ?? "", "base64"));
} catch {
  sigOk = false;
}
const idOk = !opts["--key-id"] || opts["--key-id"] === keyId;

console.log(`${hashOk ? "✓" : "✗"} sha256 matches canonical receipt (${receipt.sha256.slice(0, 16)}…)`);
console.log(`${sigOk ? "✓" : "✗"} Ed25519 signature valid (receipt keyId ${receipt.signature?.keyId}, checked with key ${keyId} from ${source})`);
if (opts["--key-id"]) console.log(`${idOk ? "✓" : "✗"} key id ${keyId} ${idOk ? "matches" : "does not match"} --key-id ${opts["--key-id"]}`);
console.log(`  sandbox ${receipt.sandboxId} · provider ${receipt.provider} · simulated=${receipt.isolation?.simulated} · destroyed=${receipt.isolation?.destroyed}`);
process.exit(hashOk && sigOk && idOk ? EXIT.valid : EXIT.invalid);
