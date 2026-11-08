# External MCP pipeline validation

Validated on 2026-11-06 with DSH 0.2.2-rc.1 and `chatgpt-web/gpt-6-light` (Instant), running headless DSH against the local-shell-dsh connector. Existing local changes were preserved.

## Fixes

- Normal terminal SSE events finish without invoking the cancellation hook. HTTP read, enqueue, cancellation, and explicit interruption now settle idempotently. Interrupting a pending read also terminates the outer stream.
- Metadata-free DSH continuations derive their turn identity from the current human instruction and session cache key. Injected runtime/skill messages and tool results do not replace that instruction. Repeated identical instructions in the same history create distinct turns. Native turn metadata remains authoritative.
- Tool-result matching prefers exact IDs, then accepts the provider response-item suffix added by pi-ai. The same matching rule applies during compaction handoff.
- Connector approval is handled while waiting for the first assistant message, as well as during submission and response observation. Automatic approval uses the per-call action.
- Undelivered broker invocations are withdrawn when their caller disconnects. Delivered invocations retain their original IDs until their results arrive.
- The response cache observes completion actions outside the answer subtree, sharing one document observer across response replacements. Observation errors are reported separately from absent response nodes.
- Turn discovery and rebinding accept both the renderer's native `data-content-search-unit-key` and its `data-chatgpt-search-unit-key` alias. Nested wrappers with one identity are treated as one turn; ambiguous separate roots remain an error. Locators follow alias/native replacements dynamically.
- The external MCP prompt requests `timeout_s: 120` on the outer local-shell gateway call. Its default 60 seconds is shorter than the dsh MCP invocation deadline of 90 seconds. Longer operations need an advertised background-job tool and polling.
- Metadata-free correlation also excludes DSH's sampled time, working-directory notices, and both initial and read-triggered AGENTS.md instruction envelopes. These context updates retain the human turn owning the pending result.
- Assistant rebinding proves a newly hydrated user node matches the submitted prompt, while retaining competing-user and ambiguous-root rejection. A running connector task with no transcript receives a bounded generation allowance.
- Current paragraph-wrapped table cells preserve numeric values and valid Markdown rows. DIV-wrapped code sources retain fences, indentation, and line breaks; numeric-only answers are preserved.

## Live results

| Exercise | Result |
| --- | --- |
| Two sequential bash calls | `ONE`, then `TWO`; gateway durations 916 ms and 1,980 ms |
| Calculator task | Ten sequential calls through glob/bash/write/read/edit; deliberately broken subtraction produced two failures; edit fixed it; final eight unit tests passed |
| Deadline boundary | `sleep 65; echo LONG_ONE` completed at the gateway in 65,412 ms; the next call returned `AFTER_LONG_TWO` |
| Resume an existing DSH session | Two additional calls returned `RESUMED_ONE` and `RESUMED_TWO`, using a fresh turn token |
| Repeat the identical instruction in that session | A distinct turn identity completed both calls; replayed results from previous turns did not satisfy new outstanding calls |
| Native/alias compatibility smoke after the nested-wrapper fix | Both resumed commands and final response completed; each SSE response logged terminal output and `[DONE]` |
| Post-reboot recovery | Existing saved login verified; rebuilt adapter returned `REBOOT_ONE`, then `REBOOT_TWO`, and completed the final response |
| Directory and instruction continuation regression | Six calls: working_directory/bash/read/bash/glob/bash; all three CONTEXT markers returned; one identity across directory/instruction injection and the subsequent read; gateway calls 354–2,445 ms; final SSE completed |
| Output fidelity on rebuilt bundle | Two sequential calls returned FORMAT_ONE / FORMAT_TWO in 2,344 / 1,391 ms; final table retained rows 1 / 2 and a fenced code block retained one output per line |

An initial calculator attempt encountered a renderer disappearance and was retained in diagnostics. Subsequent calculator, deadline, resumed-session, and repeated-instruction runs completed. Renderer compatibility and observation diagnostics were extended during this investigation; these tests do not establish behavior across every future ChatGPT UI revision or a full context-compaction cycle.

Latest local validation: `bun test` (50 passing tests, including real Chromium DOM/cache/hydration fixtures, context identity, output conversion, and reboot/session-check regressions), `./node_modules/.bin/tsc --noEmit`, `bun run build`, and `git diff --check`.

## Recovery after reboot

The first post-reboot attempt encountered DNS failure; a later attempt reached a signed-in ChatGPT page still showing `Loading profile`. The old session check collapsed any failed fetch, HTTP error, or malformed response into a sign-in error, which the generic bridge labeled `invalid_api_key`. A fresh browser probe confirmed that the saved cookies still returned an authenticated session, so no new login was required.

Session verification now retries up to three read-only checks. Network failures, server/challenge responses, rate limiting, malformed responses, and unfinished profile loading retain their own retryable error classifications. Only a completed signed-out check requests login. No session-token values are logged or cleared.

The debugging gateway's transient unit had also disappeared during reboot. It is now installed as an enabled user service, `dsh-chatgpt-gateway.service`, with startup health verification and retry on failure. The DSH plugin already starts the sidecar automatically when needed.

## Correlating the pipeline

The sidecar logs include:

- `continuation_entry`: hashed execution trace, turn identity, round identity, and input tool-result count. Trace/identity remain stable within a turn; round changes as tool results are appended.
- `tool result match`: outstanding, received, and matched counts.
- Broker waiter registration/removal and invocation queue/delivery/completion/disconnection events.
- `stream_completed` / `http_stream_completed`: terminal and `[DONE]` state.
- `http_stream_failed`: the precise read/enqueue/cancel stage.

Turn tokens are capability handles minted by this bridge, rather than a local-shell routing requirement. They bind the independently running connector process to the correct DSH turn, workspace, and tool inventory. Keep one token throughout a turn and use the newly injected token for the next user turn. Logs use token hashes instead of the token itself.

## Current local runtime

- Sidecar service: `dsh-chatgpt-debug-sidecar.service` (systemd user transient unit).
- Gateway/router service: `dsh-chatgpt-gateway.service` (enabled systemd user service).
- Current debugging sidecar log: `/home/pontes/.dsh/storages/chatgpt-web/logs/sidecar.log`.
- Gateway audit: `/home/pontes/lsm-workspace/.local-shell-mcp/audit.jsonl`.
- Stable MCP URL: `https://pontes-katana.tailc823cf.ts.net/mcp`.
- Gateway startup: `~/local-shell-mcp/start-funnel.sh`. Its output includes a secret; redirect it to a private log or discard it.

These services survive a stopped debugging shell. The gateway starts at user login; the debugging sidecar unit is transient, and future sidecar startup is owned by the DSH plugin. Keep exactly one sidecar owning the Unix broker socket. Validation uses headless DSH and does not stop the user's TUI.

The original `/tmp/dsh-mcp-*-instant.log` validation outputs were cleared during reboot; persistent browser diagnostics retain their checkpoints. Current durable evidence is under `~/.dsh/storages/chatgpt-web/logs/`: `cwd-continuation-live-verified.log`, `format-pipeline-live.log`, and `context-regression-tests.log`. The directory test's DSH journal is session `session-5e1c60f4-f5af-43e6-8b50-68157ad35a90` under `--home-pontes-tui-complex-test-20261106--`; its browser trace is `709d4d4214e8`. The formatting smoke's trace is `6415d5c666bc`.
