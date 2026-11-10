# Browser compaction failure fallback — 2026-11-09

## Problem

A compaction request is a model request. When the browser compactor lost its surface, the adapter
returned a terminal error. If DSH issued that compaction as part of a user turn, the user saw a
`turn_error` instead of a usable checkpoint.

## Behavior

A browser compaction failure now returns a **local, deterministic checkpoint** instead of failing the
request:

- the browser compactor is still attempted first (and retried once on a fresh surface);
- if it still fails with a recognized browser/surface failure (`chatgpt_response_detached`,
  `chatgpt_response_dom_lost`, `chatgpt_dom_observation_timeout`, `chatgpt_assistant_turn_missing`,
  `compaction_source_unavailable`, or another retryable adapter failure), the adapter builds
  `buildLocalCompactionFallback()`;
- deterministic non-browser failures (invalid input, configuration, auth) still return an error;
- DSH text compaction returns the fallback as the final answer;
- structured Codex compaction returns a valid `compaction` output item whose `ocx1:` envelope
  decodes to the fallback.

The fallback preserves, within a 48,000-character bound:

- the last three human requests (verbatim, bounded);
- the last assistant state and the next step;
- exact file paths mentioned in the transcript;
- recent tool results that contain errors or failures;
- the most recent transcript entries verbatim, explicitly labelled as a local fallback.

It excludes compaction directives (`CONTEXT CHECKPOINT COMPACTION`, the DSH compaction engine
directive, and prior `<compacted-summary>` blocks) so the directive never becomes the next objective.

## Evidence

`tests/compaction-fallback.test.ts`:

1. unit test: the fallback preserves the latest objective, a `src/server.ts` path, a tool error, and
   excludes the directive;
2. fault-injection soak: **5 iterations**, each with a browser compaction failure
   (`chatgpt_response_detached`) followed by a user turn. All 5 compaction requests completed with
   the local checkpoint and all 5 user turns completed (`CONTINUED_AFTER_COMPACTION`);
3. structured path: a `compaction_trigger` request with a browser surface failure
   (`chatgpt_response_dom_lost`) returns a valid `compaction` item; decoding the envelope yields the
   fallback, and the next user turn completes.

Command:

```sh
bun test tests/compaction-fallback.test.ts
```

Full suite: **179 passed, 0 failed, 1,264 assertions across 32 files**; typecheck passes.

## Limits

- The local fallback is extractive, not a semantic summary. It preserves recent evidence and
  identifiers rather than compressing the whole task into a shorter narrative.
- The browser compactor is still attempted first; this change makes its failure non-fatal, it does
  not remove the browser turn on the fallback route.
- Native models bypass browser compaction entirely through the native Responses route.
