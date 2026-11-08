import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_GPT6_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
} from "../../chatgpt-web-models";
import type { ChatGptExternalMcpConfig } from "../../types";

export const CHATGPT_WEB_MODEL_ID = CHATGPT_WEB_BACKEND_MODEL;
export const CHATGPT_WEB_GPT6_MODEL_ID = CHATGPT_WEB_GPT6_BACKEND_MODEL;
export const CHATGPT_WEB_LUNA_MODEL_ID = CHATGPT_WEB_LUNA_BACKEND_MODEL;

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  /** Opt-in external ChatGPT custom-MCP bridge used instead of the OpenAI tunnel. */
  externalMcp?: ChatGptExternalMcpConfig;
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  displayLabel: "Luna" | "Think" | "Instant (即时)" | "Medium (中等)" | "High (高)" | "Extra High (超高)" | "Pro";
  uiEffortIndex: 0 | 1 | 2 | 3 | 4 | null;
  thinkEnabled: boolean;
  localTools: boolean;
}

/**
 * Context recovery is a summarization task, so use the fastest picker row from the
 * same ChatGPT model family instead of spending the user's selected reasoning budget.
 * This keeps a High/Medium work turn on its requested model while making DSH's
 * multi-request map/reduce compaction finish before pi-ai's stream idle deadline.
 */
export function resolveChatGptWebCompactionModel(modelId: string): {
  modelId: string;
  reasoning: "low";
} {
  if (modelId === CHATGPT_WEB_GPT6_MODEL_ID) return { modelId, reasoning: "low" };
  if (modelId === CHATGPT_WEB_MODEL_ID) return { modelId, reasoning: "low" };
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) return { modelId, reasoning: "low" };
  throw new Error(`ChatGPT web compaction model is not supported: ${modelId}`);
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    if (capabilities.solAvailable) {
      throw new Error("ChatGPT Luna is not available while the account exposes the Sol model selector");
    }
    const effort = reasoning ?? "low";
    if (effort !== "low" && effort !== "medium") {
      throw new Error(`ChatGPT Luna mode is not supported: ${effort}`);
    }
    const thinkEnabled = effort === "medium";
    return {
      modelId,
      effort,
      displayLabel: thinkEnabled ? "Think" : "Luna",
      uiEffortIndex: null,
      thinkEnabled,
      localTools: capabilities.localToolsEnabled,
    };
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_GPT6_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  if (!capabilities.solAvailable) {
    throw new Error("ChatGPT Sol modes are not available for this Luna-only account");
  }
  const effort = reasoning ?? "high";
  switch (effort) {
    case "low":
      return { modelId, effort, displayLabel: "Instant (即时)", uiEffortIndex: 0, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "medium":
      return { modelId, effort, displayLabel: "Medium (中等)", uiEffortIndex: 1, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "high":
      return { modelId, effort, displayLabel: "High (高)", uiEffortIndex: 2, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    // The Plus picker exposes only three effort stops (Low/Medium/High). Higher stops are
    // Pro-account only; this check runs before the turn reaches the browser layer.
    case "xhigh":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Extra High effort is not available for this account");
      return { modelId, effort, displayLabel: "Extra High (超高)", uiEffortIndex: 3, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "max":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
      return { modelId, effort, displayLabel: "Pro", uiEffortIndex: 4, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}
