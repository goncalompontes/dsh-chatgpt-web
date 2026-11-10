import type { CodexMessage, CodexParsedRequest } from "../../types";

/**
 * ChatGPT Web keeps the conversation itself and compacts it internally. A canonical DSH replay can
 * therefore be much larger than one browser composer message even though the browser conversation
 * still holds every earlier turn. When a replay genuinely cannot fit the transport boundary, keep
 * the newest complete turns and tell the model that older history lives in the retained chat
 * instead of failing the whole turn with `context_length_exceeded`.
 */
export const CHATGPT_WEB_OMITTED_HISTORY_NOTE = [
  "The transport omitted earlier conversation history because it exceeded the ChatGPT Web browser message boundary.",
  "The retained ChatGPT conversation may still contain that history, so continue from the messages below.",
  "Do not repeat work that the omitted history or the retained conversation already completed.",
].join(" ");

function isPlainAssistantAnswer(message: CodexMessage): boolean {
  return message.role === "assistant" && message.content.every(part => part.type !== "toolCall");
}

/**
 * Start indexes for progressive history trimming. Every candidate begins a complete user turn and
 * never separates a tool result from the assistant call that produced it. When the preceding
 * message is a plain assistant answer, the window starts there instead so ambiguous follow-ups
 * keep their topic anchor. Index 0 keeps the complete canonical history.
 */
export function historyTrimCandidates(messages: readonly CodexMessage[]): number[] {
  const candidates = [0];
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.role !== "user") continue;
    const previous = index - 1;
    const start = previous > 0 && isPlainAssistantAnswer(messages[previous]!) ? previous : index;
    if (start > 0) candidates.push(start);
  }
  return candidates;
}

/** Return the same request with every message before `start` omitted. */
export function withoutOldestHistory(
  parsed: CodexParsedRequest,
  start: number,
): CodexParsedRequest {
  if (start <= 0) return parsed;
  const messages = parsed.context.messages.slice(start);
  if (messages.length === 0) return parsed;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: [
        { role: "developer", content: CHATGPT_WEB_OMITTED_HISTORY_NOTE, timestamp: 0 },
        ...messages,
      ],
    },
  };
}
