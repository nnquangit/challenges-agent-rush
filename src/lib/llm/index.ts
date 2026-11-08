import { isMock } from "../config";
import { MockLlm } from "./mock-llm";
import type { LlmProvider } from "./provider";
import { VultrInferenceLlm } from "./vultr-inference-llm";

export type { LlmProvider } from "./provider";

let llm: LlmProvider | null = null;
export function getLlm(): LlmProvider {
  llm ??= isMock() ? new MockLlm() : new VultrInferenceLlm();
  return llm;
}
