# Follow-up context isolation

## Observed failure and evidence

A native DSH ACP conversation first researched Lisbon Metro, CP trains and buses.
The user then asked whether iPhone apps already had that information. The second
answer instead discussed Vista and Linux application streaming.

The native journal, canonical Responses history and browser diagnostics agree on
the correct native session. Vista appears only in the incorrect second answer,
not in any preceding request message. The first browser response and the second
submission used the same ChatGPT conversation URL. There is no evidence here of
two native session IDs merging or a different pooled page being selected.

The user confirmed having discussed Vista both directly in ChatGPT and in T3.
That makes account-level memory/history a plausible source of the unrelated topic,
but these logs cannot establish which internal model context or retrieval caused
the answer. This change is a targeted mitigation, not proof of that internal cause.

Relevant original browser traces: `fe94d2f122f9` (first request) and
`37641173a382` (follow-up). The exact canonical predecessor matched, but the
follow-up browser prompt transmitted only one message: the new user question.
Its contract called that task context complete and omitted the preceding transit
answer from the current JSON envelope.

## Change

Retained successors now include the preceding canonical assistant answer before
the new messages. Ambiguous references such as "all this information" therefore
have explicit, session-owned context in the current envelope. The transport
contract also directs the model to resolve references from that conversation,
exclude unrelated account memories/chats/projects, and clarify genuinely missing
references. Account settings and memories are not modified.

The existing session/model/compaction key, exact predecessor fingerprint, closed
page checks and fresh canonical replay fallback remain in place. Older history
stays on the correctly retained page; this change does not retransmit the entire
history or bypass input limits. Large retained-history and compaction regression
checks continue to pass. This is model-facing grounding, not an API-level switch
that disables ChatGPT account personalization.

## Validation and deployment

- Full suite: 146 tests, 0 failures, 1,081 assertions across 27 files.
- Typecheck, build, clean-package smoke, Python parsing and whitespace checks pass.
- Regression coverage gives two sessions the same ambiguous follow-up and verifies
  distinct conversation keys and the correct preceding answer in each prompt.
- Two concurrently launched live ACP clients used `chatgpt-web/gpt-6-high` on the
  shared sidecar. Both executed two turns, retained their own nonce, answered with
  their own topic, and made no tool calls. The transit follow-up named Lisbon
  public transport and Moovit; the Vista follow-up named Vista and Moonlight.
- Logs confirm separate initial browser executions and retained-page reuse for
  both successors (`ea59355c2ff9`, `0eafbc08da51`).

Live evidence: `/tmp/dsh-context-transit-live.log`,
`/tmp/dsh-context-vista-live.log`, `/tmp/dsh-acp-updates-hv7_fjn3.jsonl`,
`/tmp/dsh-acp-updates-3yq420pl.jsonl`. Native test sessions:
`46bd03ea-f98c-4f20-962c-21c8bcac2007` and
`049c779e-625f-4be6-a166-03b0ef0b0cc0`. Both smoke processes exited 0 and closed
their sessions. The affected conversation was inspected read-only.

With zero active HTTP/browser turns and no queued requests, authenticated
drain/shutdown reloaded the sidecar as PID 2729943. Gateway PID 2628246 and router
PID 1359 stayed healthy. The nonpersistent external MCP transport loads the new
bundle on each invocation. Final health again showed zero active/queued turns.
CLI SHA-256: `a4208f192b319bf4213f7c96d78e1cfca7b3ded85174cedb59e971592ab5d9af`.
