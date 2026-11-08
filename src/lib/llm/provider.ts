import type { Plan, PlanStep, Receipt } from "../types";

export interface PlanInput {
  message: string;
}

export interface Repair {
  code: string;
  note: string;
}

/**
 * Every LLM call the agent makes goes through this interface. MockLlm answers
 * from templates; VultrInferenceLlm will call Vultr Serverless Inference
 * (OpenAI-compatible /chat/completions) once accounts exist.
 */
export interface LlmProvider {
  readonly name: string;
  /** Turn a user request into a multi-step plan (JSON). */
  plan(input: PlanInput): Promise<Plan>;
  /** Given a failed code receipt, propose fixed code — or null to give up. */
  repair(step: PlanStep, code: string, receipt: Receipt, files: Record<string, string>): Promise<Repair | null>;
  /** Explain a receipt to the user in one or two sentences. */
  explain(step: PlanStep, receipt: Receipt): Promise<string>;
  /** "Vision" check of browser artifacts against what the step expected. */
  verify(step: PlanStep, receipt: Receipt): Promise<{ ok: boolean; notes: string }>;
}
