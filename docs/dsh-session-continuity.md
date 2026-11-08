# DSH session continuity

The DSH provider keeps a completed managed Chrome Temporary Chat for the next user turn. When the canonical DSH history matches that completed conversation, the next browser message includes current instructions, the preceding assistant reply, and the subsequent messages. Echoing that reply gives ambiguous follow-ups an explicit topic anchor instead of depending solely on ChatGPT's retained transcript or account context. DSH retains the canonical transcript for replay, session resume, branching and recovery.

The plugin uses the native `llm-pi-ai/request-headers` waterfall to send `x-dsh-session-id` and auxiliary `x-dsh-request-purpose` to its own local sidecar. These are transport metadata, never prompt instructions. Each DSH session gets its own browser identity; title generation and compaction requests remain separate from normal agent turns. Tool-result continuations keep the original turn identity.

Reuse requires an exact fingerprint of the completed history, ignoring parser timestamps and provider-only reasoning metadata. Missing identity, edited/rewound history, model changes, compaction, an evicted tab or a closed browser cause a fresh replay of canonical history. Reuse never silently drops history to make a request fit. Only completed, idle pages are retained, with a five-tab budget; failed and aborted turns are not cached as reusable pages.

## Why `context_length_exceeded` happened

An observed session had grown to about 177,000 inline characters. Managed Chrome used a fresh chat per turn, rebuilding all history. A universal tuning default of 120,000 characters incorrectly replaced the model-specific GPT-6/Sol composer boundary. DSH's ordinary text compaction call repeated the same full history and hit the same guard, creating a recovery loop.

The composer tuning override is now absent by default, so the existing model/account-specific boundaries apply. An explicit override still works. DSH compaction is identified by its native request purpose, runs with no DSH tool capability, and returns an ordinary text checkpoint. It does not use Codex's synthetic `compaction` item protocol. Automatic compaction remains available when DSH needs to reduce its own replay history.

ChatGPT still has finite context and individual-message limits. Retaining the web conversation avoids resending accumulated history in each composer message; it does not promise unlimited exact recall. After a sidecar restart, canonical replay must fit the selected model, or DSH needs to summarize it. The plugin checks genuine message and context limits before sending.

## Validation

`bun test` exercises session isolation, exact-history matching, changed-history rejection, closed/evicted pages, DSH purpose headers and text compaction, including the 177,350-character regression. `bun run scripts/smoke-managed-session.ts` explicitly runs a live two-turn Instant-model check using a copied login state and separate browser; it verifies actual page reuse and recall of the first turn without replaying it. It never starts or stops production services.
