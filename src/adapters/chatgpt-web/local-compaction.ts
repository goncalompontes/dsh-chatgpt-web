import type { CodexMessage, CodexParsedRequest } from "../../types";

/**
 * Deterministic, local checkpoint used only when every browser compaction attempt has failed.
 *
 * A compaction failure must never fail the user's turn. This fallback is deliberately extractive:
 * it preserves the most recent human instructions, tool results, assistant state, exact paths and
 * identifiers verbatim, rather than inventing a semantic summary. The next model receives an
 * explicitly labelled fallback checkpoint and can continue from the preserved context.
 *
 * It is bounded well below the browser compaction budget so the next turn still fits.
 */

export const LOCAL_COMPACTION_FALLBACK_MARKER = "CODEX_LOCAL_COMPACTION_FALLBACK";
const MAX_FALLBACK_CHARS = 48_000;
const MAX_VERBATIM_MESSAGE_CHARS = 6_000;

function truncate(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[truncated ${text.length - max} chars]`;
}

function messageText(message: CodexMessage): string {
  if (message.role === "toolResult") {
    const content = typeof message.content === "string"
      ? message.content
      : message.content
        .map(part => part.type === "text" ? part.text : "")
        .join("\n");
    return `${message.toolName}: ${content}`;
  }
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return "";
      if (part.type === "toolCall") {
        return `tool_call ${part.name} ${JSON.stringify(part.arguments ?? {})}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isCompactionDirective(message: CodexMessage): boolean {
  if (message.role !== "user") return false;
  const text = messageText(message).trim();
  if (/^You are now acting as a compaction engine\b/i.test(text)) return true;
  if (/^You are performing a CONTEXT CHECKPOINT COMPACTION\b/i.test(text)) return true;
  if (/<codex_active_compaction_request>/i.test(text)) return true;
  if (/CODEX_LATEST_USER_PROMPT_JSON/.test(text)) return true;
  return text.length < 20_000
    && text.includes("<compacted-summary>")
    && text.trimEnd().endsWith("</compacted-summary>");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function extractFilePaths(messages: readonly CodexMessage[]): string[] {
  const pattern = /(?:^|[\s(`"'])((?:~|\.{0,2}\/)?[\w./-]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|json|jsonl|md|yml|yaml|toml|sh|css|html))\b/g;
  const paths: string[] = [];
  for (const message of messages) {
    const text = messageText(message);
    for (const match of text.matchAll(pattern)) {
      if (match[1]) paths.push(match[1]);
      if (paths.length > 200) break;
    }
  }
  return dedupe(paths).slice(-40);
}

export function buildLocalCompactionFallback(parsed: CodexParsedRequest, reason: string): string {
  const messages = parsed.context.messages.filter(message => !isCompactionDirective(message));
  const userMessages = messages.filter(message => message.role === "user");
  const assistantMessages = messages.filter(message => message.role === "assistant");
  const toolResults = messages.filter(message => message.role === "toolResult");

  const primary = userMessages.slice(-3).map(message => `- ${truncate(messageText(message), 4_000)}`);
  const currentWork = assistantMessages.slice(-1).map(message => `- ${truncate(messageText(message), 4_000)}`);
  const nextStep = userMessages.slice(-1).map(message => `- ${truncate(messageText(message), 1_000)}`);
  const errors = toolResults
    .filter(message => /error|failed|exception|timeout|not found|denied|fatal/i.test(messageText(message)))
    .slice(-8)
    .map(message => `- ${truncate(messageText(message), 1_500)}`);
  const files = extractFilePaths(messages).map(path => `- \`${path}\``);

  const critical: string[] = [
    `- Local fallback: the browser compactor was unavailable (${reason}). This checkpoint preserves the most recent transcript verbatim so the task can continue without replaying executed tools.`,
  ];
  let remaining = MAX_FALLBACK_CHARS;
  const selected = messages
    .filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult")
    .slice(-40)
    .reverse();
  const verbatim: string[] = [];
  for (const message of selected) {
    const label = message.role === "toolResult" ? `tool_result ${message.toolName}` : message.role;
    const text = truncate(messageText(message), MAX_VERBATIM_MESSAGE_CHARS);
    if (!text) continue;
    const entry = `- [${label}] ${text}`;
    if (entry.length > remaining) continue;
    verbatim.push(entry);
    remaining -= entry.length;
    if (remaining < 2_000) break;
  }
  critical.push(...verbatim.reverse());

  const section = (heading: string, lines: string[]): string => (
    `${heading}\n${lines.length > 0 ? lines.join("\n") : "- (none)"}`
  );

  return [
    `<!-- ${LOCAL_COMPACTION_FALLBACK_MARKER} reason=${reason} -->`,
    section("## Primary Request and Intent", primary),
    section("## Key Technical Concepts", ["- (none)"]),
    section("## Files and Code", files),
    section("## Errors and Fixes", errors),
    section("## Pending Jobs", ["- (none)"]),
    section("## Current Work", currentWork),
    section("## Next Step", nextStep),
    section("## Critical Context", critical),
  ].join("\n\n");
}
