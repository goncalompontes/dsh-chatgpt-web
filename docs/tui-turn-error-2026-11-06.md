# Latest dsh-tui turn error

Diagnosis and fixes on 2026-11-06. The original failure evidence is retained below; implementation and verification status follow it.

## Confirmed final failure

The session asking for the `neverwin-rebuild` project and GitHub status ended at **18:44:56 UTC** with:

```text
chatgpt_submitted_turn_failed: ChatGPT stopped responding after the task started.
Check the ChatGPT tab before continuing.
```

The underlying browser error was more specific:

```text
ChatGPT opened another user turn while the bound assistant response was detached
```

The failing guard is in [reconcileAssistantTurnBinding](../src/adapters/chatgpt-web/browser-worker.ts). When its original assistant locator disappears, it compares currently visible user-turn identities with the identities captured when it first bound the assistant. Any newly observed user identity immediately throws, before attempting assistant rebinding.

Evidence from trace `7d0842b18e5f`:

- 18:43:50–18:44:21: the diagnostic user-node count was zero; the assistant used `fallback-turn-0:1:assistant`.
- 18:44:51: a connector confirmation card was captured and processed.
- 18:44:56: the assistant used `fallback-turn-0:2:assistant`, and the diagnostic user-node count was two. This count is raw DOM matches, not two proven distinct human messages; native and alias wrappers can both match.
- The guard threw and retired the broker capability. A later call failed after 217 ms because that capability was already retired.
- Screenshots show a partially rendered project-status answer, not a failure to sign in or send the original task.

DSH's durable log contains exactly **one human-origin message** for this turn. Other user-role entries are time, runtime, skill, working-directory, and workspace-instruction context. All **15 DSH tool calls have corresponding tool results**. The pipeline was exchanging tools successfully before the final browser abort.

The confirmed defect is treating a newly observed DOM user identity as proof that the human submitted a competing message. The captures establish a renderer identity transition after connector confirmation. They do not independently establish whether the new user node represents the original prompt becoming visible or a synthetic approval message. Either needs explicit handling; simply deleting the cross-turn guard would risk binding the wrong answer.

## Earlier continuation disruption in the same session

At 18:39:26 the `working_directory` tool changed cwd to `/home/pontes/projects/neverwin-rebuild`. DSH appended:

1. A working-directory notice.
2. An `agent-instructions` message containing the repository's workspace instructions.
3. A new runtime-context snapshot.

The metadata-free identity classifier excludes runtime snapshots and the skill catalog, but not these workspace instructions, working-directory notices, or time-context messages. The latest user-role item can therefore replace the real human instruction as its identity input.

The sidecar shows the execution trace changing from `9823559863b5` to `7d0842b18e5f` while the fifth tool result was being returned. The old broker invocation never received that result; local-shell recorded a 90,165 ms call ending unsuccessfully. The old browser turn was aborted and a new one started with the accumulated DSH history. Subsequent tool exchanges succeeded under the new trace.

This is independent of the final DOM guard failure. It explains the earlier stall/restart and shows why “multiple tool calls returned in DSH” does not prove that each corresponding MCP invocation collected its result.

## Implemented fixes

- Metadata-free turn correlation now excludes DSH's working-directory notice, sampled time, initial workspace instructions, and additional instructions injected when reading AGENTS.md. These remain in the request context; they no longer replace the human revision that owns a pending tool result. This is compatibility handling for DSH's current pi-ai projection, which loses structured message provenance; it does not expand filesystem authority.
- Assistant rebinding now accepts a late user node only when its normalized text matches the submitted prompt and there is one unambiguous assistant candidate. It rejects a different human message, an extra identical message while the original remains present, and duplicate assistant roots. Diagnostics record counts and match status without prompt text.
- A live retry exposed a related missing-DOM verdict during connector discovery: ChatGPT had replaced the transcript with a running-task surface and still displayed Stop, before any DSH batch could provide liveness. Missing-response tracking now uses the existing bounded generation allowance while Stop is visible, rather than the ordinary 60-second DOM limit. It still fails a stuck generator and retains the shorter bound when generation stops.
- Regression coverage exercises directory/context changes across a tool-result continuation and actual Chromium DOM replacements with nested native/alias wrappers, late user hydration, and competing messages.

## Verification

Typecheck, build, and all 50 tests pass. A reboot interrupted the first live verification; a subsequent run stopped before DSH execution because ChatGPT reported an MCP connection failure. Authenticated initialization and tool listing then passed both locally and through the stable public Funnel URL.

The Instant headless regression subsequently **passed all six operations**: `working_directory`, `bash`, `read AGENTS.md`, `bash`, `glob`, and `bash`. DSH's durable journal records six successful tool results and a completed turn. The directory change, injected workspace instructions, and subsequent file read remained under trace `709d4d4214e8`, identity `91129a43e15d`, and one broker capability. Every invocation queued with `waiters=1`; gateway durations were 1,383 / 2,209 / 354 / 1,346 / 628 / 2,445 ms. The final answer returned all three markers and the verified cwd, and terminal SSE output included `[DONE]`. Assistant renumbering was rebound successfully; the stricter late-user hydration case and additional-instructions envelope are separately covered by regressions.

Evidence: `~/.dsh/storages/chatgpt-web/logs/cwd-continuation-live-verified.log`; DSH session `session-5e1c60f4-f5af-43e6-8b50-68157ad35a90` under `--home-pontes-tui-complex-test-20261106--`; browser capture directory `709d4d4214e8-7fc646d2`.

The final answer also exposed output-conversion defects in ChatGPT's current renderer: paragraph-wrapped table cells lost numeric values and produced invalid Markdown rows, while DIV-wrapped code sources became inline code with collapsed line breaks. A separate live formatting probe reproduced both. Conversion now preserves table values, escapes cell pipes, retains code source whitespace and fenced blocks, and accepts numeric-only answers. Five focused conversion/buffering tests and a Chromium numeric-answer assertion cover this data loss.

The rebuilt bundle then **passed the full-pipeline formatting smoke**: two sequential bash calls returned `FORMAT_ONE` and `FORMAT_TWO` in 2,344 and 1,391 ms. The final response retained numeric table rows 1 and 2 plus a fenced block with one output per line. Trace `6415d5c666bc` reached committed browser completion and terminal SSE output. Output: `~/.dsh/storages/chatgpt-web/logs/format-pipeline-live.log`.

## Longer-term follow-up

- Preserve native DSH session, turn, and message-source identity across pi-ai → Responses. Keep context updates in their original turn while distinguishing real human steering. A native metadata bridge is preferable to expanding an endless list of text-prefix heuristics.
- Rebind assistant DOM with evidence of the submitted message and conversation ownership, accounting for virtualized user nodes and connector-generated transcript changes. Log identity/count transitions without storing prompt text. Preserve rejection of genuinely competing user turns.
- Regression scenarios: cwd change that loads AGENTS.md; late user-node hydration; approval-induced assistant-key changes; genuine new user input; and ambiguous duplicate assistant roots.
- The targeted Instant headless directory/instructions test is complete. A full context-compaction cycle remains separate from this regression's scope.

## Evidence locations

- DSH session: `~/.dsh/sessions/--home-pontes--/ff299edc-d36e-4084-96b9-267545c183c3/session.v4.jsonl.zstd`.
- Sidecar: `~/.dsh/storages/chatgpt-web/logs/sidecar.log`, traces `9823559863b5` and `7d0842b18e5f`.
- Browser captures: `~/.dsh/storages/chatgpt-web/diagnostics/browser-turns/7d0842b18e5f-e582ae15`, checkpoints 19–23.
- Gateway: `/home/pontes/lsm-workspace/.local-shell-mcp/audit.jsonl`.
- Source: [identity classification](../src/adapters/chatgpt-web/environment.ts), [browser rebinding](../src/adapters/chatgpt-web/browser-worker.ts), [tool-result matching](../src/adapters/chatgpt-web/index.ts).

Existing captures contain private task context and capability values. This report intentionally records only the relevant identities, timing, and failure facts.
