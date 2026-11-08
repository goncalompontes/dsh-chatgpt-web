# Installed T3 consumer and media follow-up

This extends `acp-live-validation-2026-11-08.md`. The overall reliability goal
remains active; direct rendered T3 UI confirmation and live overlapping reads
remain unverified.

## Actual T3 consumer behavior

The active T3 runtime version is 0.1.6. Its installed Bun executable is
`~/.t3/runtime/versions/0.1.6/t3`, SHA-256
`71028f9b60ee75198ee727818483b1baf9e64b1c05b989ccf063bb5f31367338`.
The executable retains its JavaScript function declarations. Relevant byte ranges
(end exclusive) are:

- `deriveToolActivityPresentation`: 72884911–72886105.
- `makeToolCallState`: 72901807–72903723.
- `mergeToolCallState`: 72904071–72904704.

`scripts/smoke-installed-t3-presentation.mjs` extracts only these helpers and their
needed pure dependencies, then runs the actual shipped functions in an isolated
VM with a per-call timeout and no host process/filesystem globals. It does not
execute the bundle bootstrap or start T3. It reads real ACP updates captured by
`scripts/smoke-acp-lifecycle.py --capture-updates` and checks completed/failed
consumer states, original tool identity, file-specific labels and non-file names.
Its report retains the executable digest and exact loaded declaration ranges.
This is a consumer function probe, not an observation of the rendered UI.

The probe exposed two further presentation defects:

1. Classifying `job_output`, `job_list`, terminal-management reads, and
   `working_directory` as ACP file reads caused T3 to label them “Read file”.
   They now use `other`, retaining their actual name. `glob` uses `search`.
2. Omitting arguments on terminal updates caused a completed file read to lose
   “Read README.md” and become “Read file”, even though state merging retained
   the earlier arguments. T3 derives the new title before merging. The ACP patch
   now repeats the original parsed arguments alongside title and kind.

The guarded compatibility transformation is now v3. It supports both a clean
bundle and migration from v1/v2, is idempotent, and retains per-call presentation
only until its terminal notification is sent. Its installed SHA-256 is
`83e50f1c624694e057bea0f9d62d5d7d0334dd7cadfaa015ddbc7dd9f85482b6`.
The original and intermediate backups remain beside it; the most recent is
`index.js.before-t3-presentation-v3-patch`. Installation occurred with no supervisor
clients or other running T3 ACP sessions. Fresh native hosts loaded the new patch;
the sidecar/gateway/router code did not change in this follow-up.

Native session `5c56bc4d-abf4-4f1f-8b89-29d7f62c5cf7` passed the background lifecycle
check. Captured updates `/tmp/dsh-acp-updates-6zrt5dd4.jsonl` passed the installed
consumer probe, producing:

- `bash`: “Ran command”, kind `execute`, completed.
- `read`: “Read README.md”, kind `read`, completed.
- Both `job_output` calls: “job_output”, kind `other`, completed.

Evidence is `/tmp/dsh-t3-background-v3-acp.log` and
`/tmp/dsh-t3-consumer-background-v3.json`. An earlier mixed-failure native session
`f2e5dd14-4a6c-4426-81f1-5165248e3ec3` passed one expected failed read followed by a
successful bash and final marker. Its captured updates retained the failed read's
name/kind (`/tmp/dsh-acp-updates-jx5t1rx9.jsonl`).

REA statically analyzed the shipped client module
`assets/session-logic-CVFMn9Du.js`. Complete retained Evidence is
`ev_e61d19814cde84cb7b064cd41b84392b1c7c3ebcc1bbbb23679676d5ec8587e4`, with summary
`ev_c2d6b397605b6e529243ab2b0f59c1c922b515e1ce23541940b5bcf6ce0ae658` and exported
bundle `/tmp/dsh-t3-session-logic-evidence.json`. The static module preserves
tool titles/names in timeline data. This selected-file analysis excludes 956 other
inventoried files; semantic graph coverage is incomplete and establishes no UI
execution. An earlier larger `_chat` selection reached REA's per-source timeout;
its partial Evidence is not treated as complete application coverage. The pure
function probes above are independent runtime evidence for the selected consumer
helpers, not REA-observed UI execution.

## Live media boundaries

`scripts/smoke-chatgpt-media.py --kind image` established a platform restriction:
ChatGPT answered that native image generation is unavailable in Temporary Chat.
The provider uses Temporary Chat. The response was returned honestly; no image
bytes were invented and the provider did not silently change chat persistence.
Evidence is `/tmp/dsh-live-image-export.log`.

`--kind chart` exercised ChatGPT's Python sandbox instead and passed in session
`media-smoke-dd3ca109-81d5-40fa-92e3-c10c76b929cb`. It exported a real 1,342-byte
256×256 PNG, visually verified as a blue circle on white, at
`~/.dsh/storages/chatgpt-web/artifacts/c2aee6cd-b5c1-401f-ade1-3cc7c81fba3f-blue_circle.png`.
Evidence is `/tmp/dsh-live-chart-export.log`. This proves browser-generated PNG
download bytes. It does not prove a live authenticated inline-image fetch; the
saved file came through the download stream. The authenticated image-fetch path
remains covered by Chromium fixtures.

## Concurrency evidence limits

A delayed pair of foreground bash calls also completed serially. Broker trace
`00c3d25f1004` shows the second invocation queued only after the first completed.
That run did not exercise a multi-call batch. More fundamentally, native DSH
marks file reads as `isConcurrencySafe: () => true`, while bash omits this opt-in.
DSH's contract treats omitted/non-true classifiers as exclusive. Parallel bash is
therefore not a valid acceptance criterion for its safe scheduler.

The maintained `parallel` smoke uses independent reads and requires observed ACP
overlap. It reports a missing observation without assuming which layer caused it;
captured updates and broker delivery logs distinguish model dispatch from native
scheduling. Real-socket broker tests still establish concurrent invocation,
distinct names/IDs and mixed out-of-order results. A live overlapping-read run
through the model remains open.

## Validation

129 tests passed, 0 failed, 972 assertions across 24 files. TypeScript checking,
Node syntax checking, Python parsing and whitespace checks passed. This batch
changes the compatibility transformation, diagnostics/smoke scripts and their
tests; the previously verified production CLI/plugin build remains unchanged.
Final supervisor health showed all workers healthy, no clients, no pending queue,
and zero active HTTP/browser turns.
