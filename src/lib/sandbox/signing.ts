// Receipt signing (server only). Ed25519 over the canonical receipt payload.
// Key: RECEIPT_SIGNING_KEY = base64 PKCS#8 DER Ed25519 private key, validated
// at server start (src/instrumentation.ts). Unset → an ephemeral key generated
// per process (receipts from before a restart then no longer verify against
// /api/receipts/public-key — fine for a local demo; PROOFBOX_PUBLIC=1 requires a key).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { receiptPayload } from "../receipt-canonical";
import type { Receipt } from "../types";

interface Keys {
  priv: KeyObject;
  spkiB64: string;
  keyId: string;
  ephemeral: boolean;
}

const g = globalThis as unknown as { __proofboxKeys?: Keys };

/** Thrown for an unusable RECEIPT_SIGNING_KEY. The message never contains the key. */
export class SigningKeyError extends Error {}

function loadKeys(): Keys {
  const raw = process.env.RECEIPT_SIGNING_KEY?.trim();
  let priv: KeyObject;
  if (raw) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new SigningKeyError("RECEIPT_SIGNING_KEY is not base64 (expected base64 PKCS#8 DER)");
    try {
      priv = createPrivateKey({ key: Buffer.from(raw, "base64"), format: "der", type: "pkcs8" });
    } catch {
      throw new SigningKeyError("RECEIPT_SIGNING_KEY is not a valid PKCS#8 DER private key");
    }
    if (priv.asymmetricKeyType !== "ed25519") throw new SigningKeyError(`RECEIPT_SIGNING_KEY must be an Ed25519 key (got ${priv.asymmetricKeyType ?? "unknown"})`);
  } else priv = generateKeyPairSync("ed25519").privateKey;
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return { priv, spkiB64: spki.toString("base64"), keyId: createHash("sha256").update(spki).digest("hex").slice(0, 16), ephemeral: !raw };
}

/**
 * Load and cache the signing key. Called at server start (src/instrumentation.ts)
 * so a bad RECEIPT_SIGNING_KEY stops the server instead of failing the first run.
 */
export function initSigningKey(): { keyId: string; ephemeral: boolean } {
  g.__proofboxKeys ??= loadKeys();
  return { keyId: g.__proofboxKeys.keyId, ephemeral: g.__proofboxKeys.ephemeral };
}

/** Validate a key without caching it (tests, startup checks). */
export function checkSigningKey(): { keyId: string; ephemeral: boolean } {
  const k = loadKeys();
  return { keyId: k.keyId, ephemeral: k.ephemeral };
}

function keys(): Keys {
  initSigningKey();
  return g.__proofboxKeys!;
}

export function publicKeyInfo() {
  const k = keys();
  return { alg: "Ed25519" as const, keyId: k.keyId, spki: k.spkiB64, ephemeral: k.ephemeral };
}

/** Hash + sign the complete receipt (isolation, limits, env, timestamps included). */
export function sealReceipt(unsealed: Omit<Receipt, "sha256" | "signature">): Receipt {
  const k = keys();
  const payload = receiptPayload(unsealed as unknown as Record<string, unknown>);
  const bytes = Buffer.from(payload, "utf8");
  return {
    ...unsealed,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: { alg: "Ed25519", keyId: k.keyId, value: sign(null, bytes, k.priv).toString("base64") },
  };
}
