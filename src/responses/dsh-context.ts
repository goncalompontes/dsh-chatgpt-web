import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../types";

// @deepseek-ai/dsh-compaction-basic 0.2.2-rc.1's complete, final-user compaction directive.
// Compatibility for already-running DSH hosts without our request-header plugin. An ordinary
// request to "compact" must not disable tools or select the checkpoint protocol. New versions
// should use x-dsh-request-purpose rather than relying on this pinned template fingerprint.
const DSH_COMPACTION_DIRECTIVE_SHA256 = "3b7aa71f525b9a82afc2f1747c4434ceb7b3bc1fadf8b64c37c4e97db70d074b";

export const DSH_CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

export function isDshCompactionSummaryText(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${DSH_CHECKPOINT_PREAMBLE}\n`)
    && value.includes("<compacted-summary>") && value.trimEnd().endsWith("</compacted-summary>");
}

/** Compaction changes browser execution even when DSH retries the same original human message. */
export function dshCompactionEpoch(parsed: CodexParsedRequest): string | undefined {
  const raw = parsed._rawBody as { input?: unknown } | undefined;
  if (!Array.isArray(raw?.input)) return undefined;
  for (let i = raw.input.length - 1; i >= 0; i--) {
    const item = raw.input[i];
    if (!item || typeof item !== "object" || item.role !== "user") continue;
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map((part: { text?: unknown }) => typeof part?.text === "string" ? part.text : "").join("\n") : "";
    if (isDshCompactionSummaryText(text)) return createHash("sha256").update(text).digest("hex");
  }
  return undefined;
}

export function isLegacyDshTextCompaction(parsed: CodexParsedRequest): boolean {
  if (parsed._compactionRequest || parsed._dshRequestPurpose !== undefined) return false;
  const last = parsed.context.messages.at(-1);
  if (last?.role !== "user") return false;
  const text = (typeof last.content === "string" ? last.content : last.content.map(part => (
    part.type === "text" ? part.text : ""
  )).join("")).replaceAll("\r\n", "\n").trim();
  return createHash("sha256").update(text).digest("hex") === DSH_COMPACTION_DIRECTIVE_SHA256;
}
