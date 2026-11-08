# Browser-turn incident correlation — 2026-11-07 capture

Analysis command (read-only):

```sh
node scripts/analyze-browser-diagnostics.mjs /home/pontes/.dsh/storages/chatgpt-web/diagnostics/browser-turns
```

**Scope:** Ten trace directories, 145 JSON snapshots, with capture timestamps from 2026-11-07 15:20:41Z through 15:48:20Z. The analyzer deliberately emits no prompt, title, body, or user content. Snapshot counts are not invocation counts. The diagnostic directory is a changing, incomplete sample rather than a complete incident population.

| Terminal outcome | Distinct traces |
| --- | ---: |
| Completed | 7 |
| Failed | 1 |
| Terminal not captured | 2 |

The observed failed trace is `637c4ceb3681`, captured from 15:22:16Z to 15:24:32Z, and its terminal error is `ChatGPT web turn aborted`. Its checkpoints show a visible response and a tool confirmation before the abort. This alone cannot distinguish caller cancellation, disconnected observer, or compaction-side recovery.

The three `2125fbdcbd0a-compact-{1,2,3}` traces completed at 15:24:04Z, 15:24:35Z, and 15:25:09Z. They are **compaction fragment/browser submissions**, not verified examples of tool-call resumption after compaction; their completion is not sufficient to prove correct owner handoff or late result reconciliation. Two remaining traces do not have a recorded terminal checkpoint; do not count them as success or failure.

Earlier `sidecar.log` shows two independent `Allow once` locator timeouts, but the current diagnostic directory does not contain those traces. Therefore the new diagnostic sample and earlier log incident sample must **not** be joined into a rate estimate.

## Confidence and next evidence needed

- Confirmed: one explicit abort in this capture, three completed compaction fragment submissions, two missing terminal records.
- Unsupported: claim that post-compaction tool calls routinely fail because the native session did not resume.
- Unknown: fraction of *all* production turns represented by these files, whether terminal-less traces ultimately finished, and whether broker IDs/capabilities were carried across specific compaction boundaries.

Next: instrument structured lifecycle events with stable execution/owner/round/tool-call IDs, event timestamps, explicit compaction epoch and terminal ownership; reconcile log rotation; correlate compaction boundary to the first tool call and its terminal result. Replay fixes should be idempotency-safe and avoid rerunning already-executed tool commands.

## Adaptive scheduling stage

Added `src/adapters/chatgpt-web/browser-capacity.ts` as a **policy module only**. It calculates capacity with a hard maximum of five, 4 GiB memory reserve, provisional 768 MiB per active turn, CPU load headroom and a fast-down/slow-up cooldown controller. These are configurable placeholders, **not calibrated measurements** and **not yet connected to the live browser worker**. The DSH runtime retains its five-slot physical cap. Integration requires reliable host and launcher/browser RSS measurements, cgroup-aware memory accounting, periodic recalculation and shutdown-safe lifetimes; do not present the policy unit tests as proof of live adaptive concurrency.

Additional resource sampling (same date, later session):

- Added `src/adapters/chatgpt-web/browser-resources.ts` with dependency-injectable, read-only Linux host /proc/meminfo sampling, cgroup v2 memory headroom and CPU quota awareness. It deliberately returns null when core host metrics cannot be trusted, allowing the estimator to fall back to its minimum. It does not alter browser sessions or installed services.
- Added `tests/browser-resources.test.ts` for normal host measurements, cgroup ceilings, unlimited cgroup values, invalid host data, and over-limit cgroups.
- A later diagnostic inventory (live directory, changing over time) showed 10 trace folders and 189 numbered snapshots, with 7 completed, 1 aborted, and 2 without recorded terminal markers. These are **not** the same trace identities as the preceding inventory: the latest completed traces were mostly `001cfe4c1ab0-compact-*` and `186a1bb95b77-compact-*`; the failed trace was `f6e14ab6dd94`. This supports log/sample rotation or replacement, not a stable aggregate incident rate.
- Added `browser-capacity-monitor.ts` and connected it to the production `chatGptTurnSessions` singleton. Observation starts lazily at admission; an unref'ed 10-second poll remains active while physical turns or queued waiters exist, and stops when idle. Invalid sampler data reduces future capacity to one. Samples cannot increase the capacity beyond the separate five-turn browser-worker guard; existing leases are not preempted. The same-owner physical-retirement handoff remains mandatory.
- Added three monitor regression tests for FIFO growth, pressure-driven downscaling without preemption, aborted queued requests, and fail-closed sampling. Test registry instances retain deterministic fixed capacity unless explicitly given a sample function.
- **Still pending:** measure incremental browser/launcher RSS rather than provisional 768 MiB, instrument queue wait latency and pressure, confirm live production behavior and shutdown paths, and investigate lifecycle/approval failure evidence. The new admission integration is source-only and has **not** been deployed or verified in a live ACP session.

Latest prior full regression: 106 tests passed, 0 failed, 596 expectations across 22 files; `bun run typecheck` and `git diff --check` passed.

## Follow-up approval selector isolation

Two historical sidecar traces (`c714f0b524f9` and `459a931701d7`) show `tool-confirmation-visible` immediately preceding a 10-second Playwright `Allow once` locator timeout. These traces reflect an older selector (`getByRole('button').filter({ hasText: /^Allow once/ })`), so they cannot establish whether the current details-dialog state machine resolves the incident in production. The live diagnostic population has rotated again, and its completion statistics are not comparable to earlier snapshots.

A separate deterministic safety regression exposed an ambiguity in the current implementation: a page-wide `Allow once` fallback can select the button of an unrelated connector when the requested connector only exposes `See details`. `tests/chatgpt-approval.test.ts` now reproduces simultaneous approval notifications, and `chatGptApprovalAllowOnce` avoids page-wide candidates while multiple matching approval cards are present. The requested connector's own direct button remains eligible. This conservative behavior can time out instead of approving when multiple independent cards are visible; that is intentional until a connector-specific details-panel association can be proven. The targeted browser suite passed (3/3). Live UI and ACP behavior remain unverified; do not automatically replay side-effecting tool calls.

## Physical retirement rejection regression

The native session registry had a deterministic cleanup error path: `beginRetirement` registered `.then(onFulfilled)` handlers without rejection handlers for physical helper settlement. If a launcher cleanup promise rejected, the derived cleanup promises could reject unobserved and owner-retirement state could remain rejected. Added a regression in `tests/browser-session-admission.test.ts` that first causes physical settlement to reject, verifies `retireAndWait` reports the original error, and then verifies the next same-owner execution can be admitted. This failed before the fix and passes afterward.

`turn-execution.ts` now uses a settled (resolve-on-both-outcomes) barrier for registry cleanup and serialization, while returning the original physical settlement promise to callers that need failure reporting. Waiting behind an active owner's failed physical settlement also recognizes that the physical turn has terminated. This does not retry any delivered tool calls and does not change browser-worker cleanup.

Latest full regression after this fix: **108 passed, 0 failed, 602 assertions across 22 files**; `bun run typecheck` and `git diff --check` pass. The approval suite still intermittently reports Bun's `TimeoutNegativeWarning` despite passing. The causal relationship to the historical 10-second approval timeouts remains unproven. No live ACP integration, service restart, deployment, commit, or PR is verified.

## Retained-conversation teardown failure cleanup

A further deterministic regression showed that `closeConversationAndWait` only called `releaseRetainedConversation` when all physical-settlement promises fulfilled. If a launcher/helper teardown rejected, the external caller received that failure but the retained conversation release callback was skipped. Added a failure-path test to `tests/browser-session-admission.test.ts` and changed the cleanup to run in `finally`, preserving the physical failure for the caller while releasing the retained epoch. The new test failed before the change and passes afterward. This is source-level validation only, not evidence of live ACP reconnection correctness.

## Later invocation correlation (18:18–18:27 UTC)

A fresh read-only diagnostic inventory contained **10 directories and 167 snapshots: five completed, two aborted, three without a terminal record**. This is a changing capture population, not an aggregate reliability measurement. Distinguish invocation folders from their nonunique `traceId` labels.

The current `74c954a5c065-compact-2-08903d47` invocation reached `effort-menu-keyboard-open`, `model-already-selected`, `effort-slider-visible`, `effort-selected`, and `turn-completed` by 18:22:33Z. Likewise, `5913857432e9-compact-{1,2,3}` each completed after the same effort-selection checkpoints. An earlier error bearing the `74c954a5c065-compact-2` trace label therefore **must not be assigned to this later successful invocation**. No reproducible effort-picker failure has yet been established from the retained snapshots; changing the selector on that basis would be speculative.

`a04df7193b2e` and `e93a914d058d` progressed to `tool-confirmation-visible`, but neither had a recorded terminal checkpoint at inventory time. The `a04df7193b2e` approval snapshot includes a visible **local-shell-dsh** permission card with `See details` and no terminal outcome. This demonstrates an outstanding approval state, not that permission was granted, the tool executed, or a tool result returned to the broker. The other terminal-less trace (`2f4bc014dba6`) stopped after a response-stalled checkpoint; its outcome remains unknown.

Next evidence should correlate native `threadId`, `turnId`, compaction epoch, execution/round keys, approved connector identity, tool-call ID, broker completion and physical settlement in one invocation-scoped event stream. Avoid automatically replaying any command that may already have executed. Do not equate successful compaction browser submissions with post-compaction tool recovery.

## Capability retirement on failed physical settlement

Source inspection identified an additional deterministic cleanup defect: `ChatGptTurnSession.scheduleCapabilityRetirement()` only chained `retireCapability()` through the successful branch of `physicalSettlement`. A rejected launcher teardown therefore skipped capability revocation, even though the physical turn was settled. Added `turn capability is retired even when physical teardown rejects` to `tests/browser-session-admission.test.ts`: it failed before the fix (`retirements=0`, expected 1) and passes afterward. `turn-execution.ts` now waits for the observer tail on both physical settlement outcomes, invokes capability retirement, and leaves the original settlement rejection visible to callers. This is an exact cleanup correction; it neither retries nor replays tool calls. Full local suite: **110 passed, 0 failed, 607 assertions in 22 files**. Typecheck and whitespace checks passed. Live ACP approval and post-compaction tool recovery remain unverified.

## Nested-pipe continuation identity collision

Follow-up inspection identified a deterministic result misrouting defect in `outstandingChatGptToolCallId()`: when outstanding calls include both `call_a` and `call_a|exact`, the DSH/pi-ai continuation ID `call_a|exact|provider` was normalized to `call_a` rather than `call_a|exact`. The regression in `tests/continuation-lifecycle.test.ts` failed with the wrong call ID before correction and passes afterward. The matcher now checks exact IDs first and otherwise selects the longest outstanding pipe-delimited prefix. Both ordinary continuation and compaction handoff use this shared matcher. Local verification: **110 passed, 0 failed, 608 assertions across 22 files**; TypeScript typecheck and `git diff --check` passed. This addresses deterministic routing only; ambiguous broker acknowledgement and live tool execution remain unverified, and no side-effecting tool was replayed.
# Follow-up: concurrent effort-picker failures (2026-11-08)

An eight-client queued admission run exposed a repeatable upstream failure under
load: three clients received `ChatGPT effort control did not expose its owned menu
or structural slider after click and primary pointerdown`. The sidecar remained
healthy, capped active browser turns at five, and drained the queue. The failure
occurred during independent page effort-control setup, before tool execution.

`activateChatGptEffortMenu` now retries the semantic keyboard/click/pointerdown
activation sequence up to three times, clearing ghost picker state between
attempts. The retry is bounded and does not replay a submitted prompt or tool
call. The admission smoke accepts a configurable client count so the workload is
reproducible (`--clients 8`). After deployment, the repeated eight-client run had
no effort-picker failures; seven clients completed and one exceeded the smoke
client's 300-second end-to-end timeout after a 166-second admission wait and a
later response-stall retry. The sidecar remained healthy, capped active turns at
four, and drained all seven pending requests. This run alone does not isolate the
timeout's cause: its budget includes admission, browser setup, connector wait,
tool execution and response completion.

## Shared persistent connector coupling

A subsequent eight-client run with a 600-second client budget still failed:
two model responses reported `persistent MCP connection closed`, and one client
timed out. Source inspection of the installed local-shell MCP manager showed
that `_PersistentConnection._serve` serializes all tool calls through one queue.
The per-call timeout includes time in that queue; a timeout closes the shared
connection and rejects the other queued clients. DSH uses a separate turn broker
for session state, so this process persistence adds cross-client coupling without
being necessary for DSH continuity.

The live `dsh` registry was changed through `manage(action='unpersist', name='dsh')`
to use an independent stdio transport per invocation. The gateway and sidecar
were already stopped by the supervisor after an idle window with no clients;
`stack.py ensure` then started fresh workers with the new configuration. No
active user session was interrupted. A staged HTTP idle-timeout increase was
reverted: idle-termination log lines do not establish the shared-worker failure.
Do not restore `persistent=true` for this stateless broker connector. The stack
installer was also corrected in `dsh-web-stack` commit `fee25a5` so new
registrations use independent transports. Existing registries are intentionally
not overwritten by the installer; they require the explicit `unpersist` action.

The rerun passed **all eight clients**. Evidence is
`/tmp/dsh-admission-load-khsyoo0c/` (per-client logs and 99 resource samples).
Adaptive capacity grew from one to five; observed active turns peaked at four,
pending admissions peaked at seven, sidecar-descendant summed RSS peaked at
4,573,265,920 bytes (4.26 GiB), and maximum admission wait was 139,805 ms. All
eight native bash calls and final markers completed. This validates queued
multi-client tool round trips with independent transports, not large-document
or image-generation memory costs. Keep the five-turn cap, 4 GiB reserve and
3 GiB per-turn allowance. The browser regression for delayed picker hydration
passes; final local suite: 133 tests, 0 failures, 989 assertions, plus typecheck.
