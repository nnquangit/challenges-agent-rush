// VultrInferenceLlm — STUB. Reads config from env; makes NO network calls in
// the mock-first phase. Only constructed when MOCK=0.
//
// Intended implementation: POST `${baseUrl}/chat/completions` (OpenAI-compatible)
// with `response_format: { type: "json_object" }` and a system prompt that asks
// for the same Plan JSON MockLlm returns; validate the JSON before using it.

import { isMock, vultrInferenceConfig } from "../config";
import type { Plan, PlanStep, Receipt } from "../types";
import type { LlmProvider, PlanInput, Repair } from "./provider";

export class VultrInferenceLlm implements LlmProvider {
  readonly name: string;
  private readonly cfg = vultrInferenceConfig();

  constructor() {
    if (isMock()) throw new Error("VultrInferenceLlm must not be constructed while MOCK=1");
    this.name = `vultr-inference (${this.cfg.model || "model unset"})`;
  }

  private notYet(method: string): never {
    const missing = [!this.cfg.model && "VULTR_INFERENCE_MODEL", !this.cfg.apiKeyPresent && "VULTR_INFERENCE_API_KEY"].filter(Boolean);
    throw new Error(
      `VultrInferenceLlm.${method} is a stub (mock-first phase); would call ${this.cfg.baseUrl}/chat/completions.` +
        (missing.length ? ` Missing env: ${missing.join(", ")}.` : ""),
    );
  }

  async plan(_input: PlanInput): Promise<Plan> {
    return this.notYet("plan");
  }
  async repair(_s: PlanStep, _c: string, _r: Receipt, _f: Record<string, string>): Promise<Repair | null> {
    return this.notYet("repair");
  }
  async explain(_s: PlanStep, _r: Receipt): Promise<string> {
    return this.notYet("explain");
  }
  async verify(_s: PlanStep, _r: Receipt): Promise<{ ok: boolean; notes: string }> {
    return this.notYet("verify");
  }
}
