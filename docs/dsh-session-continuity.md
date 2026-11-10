# DSH session continuity

The DSH provider keeps a completed managed Chrome Temporary Chat for the next user turn. When the canonical DSH history matches that completed conversation, the next browser message includes current instructions, the preceding assistant reply, and the subsequent messages. Echoing that reply gives ambiguous follow-ups an explicit topic anchor instead of depending solely on ChatGPT's retained transcript or account context. DSH retains the canonical transcript for replay, session resume, branching and recovery.

The plugin uses the native `llm-pi-ai/request-headers` waterfall to send `x-dsh-session-id` and auxiliary `x-dsh-request-purpose` to its own local sidecar. These are transport metadata, never prompt instructions. Each DSH session gets its own browser identity; title generation and compaction requests remain separate from normal agent turns. Tool-result continuations keep the original turn identity.

Reuse requires an exact fingerprint of the completed history, ignoring parser timestamps and provider-only reasoning metadata. Missing identity, edited/rewound history, model changes, compaction, an evicted tab or a closed browser cause a fresh replay of canonical history. Reuse never silently drops history to make a request fit. Only completed, idle pages are retained, with a five-tab budget; failed and aborted turns are not cached as reusable pages.

## Why `context_length_exceeded` happened

An observed session had grown to about 177,000 inline characters. Managed Chrome used a fresh chat per turn, rebuilding all history. A universal tuning default of 120,000 characters incorrectly replaced the model-specific GPT-6/Sol composer boundary. DSH's ordinary text compaction call repeated the same full history and hit the same guard, creating a recovery loop.

The composer tuning override is now absent by default, so the existing model/account-specific boundaries apply. An explicit override still works. DSH compaction is identified by its native request purpose, runs with no DSH tool capability, and returns an ordinary text checkpoint. It does not use Codex's synthetic `compaction` item protocol. Automatic compaction remains available when DSH needs to reduce its own replay history.

ChatGPT still has finite context and individual-message limits. Retaining the web conversation avoids resending accumulated history in each composer message; it does not promise unlimited exact recall.

## Context capacity and transport fit

ChatGPT Web compacts its own conversation, so the model catalog advertises a conversation
capacity rather than the measured single-message browser ceiling. The harness therefore no longer
compacts (or reports a false overflow) merely because the canonical transcript exceeds that
ceiling, and `auto_compact_token_limit` is raised to the same capacity.

Retention is a browser-host capability, not a tool-mode feature: Pure Chat turns with a stable DSH
session identity (or a `prompt_cache_key`) reuse their completed managed Chrome conversation as
well, so each follow-up sends only its new instruction.

When a fresh replay still cannot fit one browser message (a restarted sidecar, an edited history,
an evicted tab), the adapter keeps the newest complete user turns, prepends a short note explaining
that older history stays in the retained conversation, and submits that instead of failing. The
selection uses a binary search over user-turn boundaries, keeping the immediately preceding plain
assistant answer when one exists, so a tool result is never separated from its assistant call and
the cost stays logarithmic. The original `context_length_exceeded` diagnosis only surfaces when
even the newest turn alone is larger than one browser message; the plugin still checks genuine
composer and message limits before sending.

`tests/context-continuation.test.ts` covers the advertised capacity, Pure Chat retention across
turns, and the omission note; `tests/acp-overflow-recovery.test.ts` verifies that an oversized ACP
replay now completes while a checkpoint request still summarizes every source fragment.

## Validation

`bun test` exercises session isolation, exact-history matching, changed-history rejection, closed/evicted pages, DSH purpose headers and text compaction, including the 177,350-character regression. `bun run scripts/smoke-managed-session.ts` explicitly runs a live two-turn Instant-model check using a copied login state and separate browser; it verifies actual page reuse and recall of the first turn without replaying it. It never starts or stops production services.
