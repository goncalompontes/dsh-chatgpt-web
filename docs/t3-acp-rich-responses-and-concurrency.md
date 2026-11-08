# T3/ACP tool presentation, rich response conversion, and concurrency

Source investigation: 2026-11-07. This is a development handoff, not a claim of complete end-to-end feature delivery. Existing uncommitted changes are preserved.
Later implementation/deployment status supersedes the historical pending notes below:
see `acp-live-validation-2026-11-08.md` and `acp-consumer-validation-2026-11-08.md`.
The compatibility patch is now installed and live-tested; queued admission is deployed.

## 1. Why T3 shows generic tool cards

- `src/adapters/chatgpt-web/index.ts` (`emitToolBatch`) emits one `tool_call_start` per broker request with `name: request.wireName`. The adapter and `src/bridge.ts` preserve `name` and `call_id` in standard Responses `function_call` items. Tests in `tests/continuation-lifecycle.test.ts` verify two different names and call identities survive the SSE boundary.
- The installed DSH ACP implementation (`@deepseek-ai/dsh-acp/lib/index.js`, `toolCallUpdate`, lines 548–556 on 2026-11-07) creates `{ sessionUpdate: 'tool_call', toolCallId, title: event.data.name, kind: 'other', status: 'in_progress', rawInput }`. `toolResultUpdate` sends completion and converted content. DSH's `tool/call` event schema includes `name`, `arguments` and `callId`.
- Therefore, the bridge does not systematically replace tool names with the literal `tool`. The generic T3 display is downstream of the Responses output. To distinguish whether the ACP event itself carries `tool` or T3 ignores its `title`, inspect an actual `session/update` payload in a live T3 ACP session (not just the DSH Web or TUI tools view). Do not conflate MCP transport `dsh:bash` with the inner DSH tool named `bash`.

### Recommended change

1. In the DSH ACP adapter, derive a truthful standard ACP `kind` (`read`, `edit`, `execute`, `delete`, `search`, `fetch`, `other`) for known tool names, keeping a generic fallback; preserve the raw name as `title` and arguments as `rawInput`. Never pass raw arbitrary tool content as a title. For shell calls, include a concise, sanitized command label only when the verified name is `bash`, and keep tool name visibly associated with it.
2. Verify T3 uses `session/update` `tool_call.title` and `kind` instead of hardcoding a generic label. If T3 does not, fix its ACP presentation renderer, not the ChatGPT prompt. Keep the same `toolCallId` across initial and terminal updates. Nested gateway calls may require explicit data correlation to present the inner name, not merely rename the outer tool.
3. Test one `bash`, one `read`, two parallel calls, nested MCP forwarding, result failure, approval, and resume in T3. The installed `dsh-acp` package intentionally projects standard ACP lifecycle, not native DSH UI cards, so rich DSH-specific card parity requires coordinated client support.

A guarded, opt-in compatibility transformation is available at `scripts/patch-dsh-acp-tool-presentation.mjs`. It adds truthful tool kinds, retains call-ID-to-tool-name correlation per ACP session, and repeats `title`/`kind` on terminal updates (where DSH's unmodified ACP implementation only sends call ID and status). `tests/acp-tool-presentation.test.ts` validates patch idempotency, named start events, and completed/failed terminal events using an in-memory patched copy. The patch has **not** been applied to the installed ACP bundle; applying it requires a coordinated DSH restart and is intentionally deferred while user agents are active. This is a compatibility workaround, not a verified T3 client-side fix; live ACP event capture and T3 rendering still need validation.

Dry-run only: `node scripts/patch-dsh-acp-tool-presentation.mjs /home/pontes/.local/opt/deepseek-harness/node_modules/@deepseek-ai/dsh-acp/lib/index.js`. An explicit `--apply` creates a sibling backup and modifies the installed bundle; do not run while active sessions depend on it. Prefer upstreaming the source-level behavior into `@deepseek-ai/dsh-acp` instead of maintaining an installed-bundle patch long term.

## 2. Rich responses

- The converter is `src/adapters/chatgpt-web/markdown.ts`, using Turndown plus GFM rules and block-level append-only streaming.
- Existing regression coverage already verifies paragraph-wrapped table values, escaped pipes, `data-code-block-source` indentation/newlines, fenced code, and numeric answers. Earlier blanket digit removal is gone.
- Previously, image nodes were always dropped. This review preserves Markdown image links for absolute HTTP(S) sources and emits bounded descriptive fallbacks for `blob:` and `data:` images. It never copies opaque inline base64 image bytes into text. `source` nodes remain ignored.
- The live browser DOM extractor previously classified all map and carousel containers as noise and discarded them before conversion. It now preserves wrappers with meaningful place headings/links; the Markdown converter returns deduplicated place labels and accessible ordinary links while filtering map tiles and UI controls. Focused regression tests cover the semantic fallback and pure-control exclusion.
- Current limits: SVG/canvas, visual map geometry, interactive cards, attachment bytes, and image-only data contained in browser-rendered components are **not faithfully representable by ordinary Markdown**. Turndown's blank-node behavior also drops some semantic data embedded in `picture` or unlabeled vector nodes. Browser-only blob references cannot be opened in DSH without explicit file transfer.

### Recommended change

Split browser extraction into a normalized semantic response model with blocks (`paragraph`, `heading`, `list`, `table`, `code`, `image`, `link`, `citation`, `artifact`, `unsupportedWidget`) and preserve source provenance. Render Markdown when the receiving transport supports only text; use structured attachments and DSH's `present` path when real media bytes can be transferred. Extract media using authenticated browser download events or explicit source references, never silently turn arbitrary page resources into local files. For interactive widgets retain accessible text and source links when present, and accurately mark unsupported content. Test on captured real ChatGPT HTML for each widget family and streaming replacements.

Avoid attempting to reconstruct CSS, canvas pixels, or structured client widgets from text-only DOM snapshots; this is a transport capability boundary, not just a Markdown parsing bug.

## 3. Concurrent calls and background jobs

### Confirmed capabilities

- Multiple MCP invocations can coexist on a claimed turn. The broker maintains independent `callId` entries, queues calls, and coalesces arrivals for 15 ms when a waiter is present (`turn-broker.ts`, `scheduleToolWaiters`). It emits one batch to the adapter, and `emitToolBatch` produces an independent Responses call for each request. An explicit test invokes `bash` and `glob` concurrently and completes them in reverse order without mixing results.
- The adapter expects the entire outstanding batch in the next Responses continuation (`src/adapters/chatgpt-web/index.ts`); it rejects incomplete matched result sets. This is a round barrier, not evidence that DSH tool execution is serial.
- `parallel_tool_calls` is accepted in the local Responses request parser. The browser connector is separate and may issue MCP calls serially; the 15 ms window only groups calls that actually arrive together. Real browser/T3 end-to-end concurrency still needs a live test.
- DSH ships background jobs independently of ChatGPT. `dsh-tool-bash` supports `run_in_background` and timeout promotion when the DSH job registry/controller is composed; `dsh-tool-jobs` supplies `job_output`, `job_list`, `job_kill` and completion notices. A harmless current connector call returned a `bash-...` job ID and `job_output` returned its completed output with exit code 0. This confirms the selected DSH profile supports background work through the connector.

### Remaining integration work

1. Prompt/inventory: convey `run_in_background`, `job_output`, and completion-notice behavior from the *current native schema*, not from a static allowlist. Prefer async jobs for commands expected to exceed the MCP invocation deadline. The sidecar MCP call timeout is 90 seconds; a gateway call generally needs a greater deadline (currently recommended `timeout_s: 120`). Background work must return an ID well within this window.
2. Model continuation: attach job lifecycle facts and completion notices to the correct owner/session and deliver them at a safe model/turn boundary. Do not poll a running job needlessly or claim job completion before checking the tool result.
3. Live test matrix: two simultaneous external MCP calls; two DSH tool calls emitted in one Responses round; one long background bash command while another tool call executes; out-of-order completion; cancellation; one call failing; session resume; concurrent browser tabs; and ACP/T3 card labels for each call.
4. Maintain boundaries: DSH owns job permissions and its process-local lifecycle. Browser tab concurrency (up to five retained/active tab slots in the implementation) is distinct from parallel tool calls within one agent turn. DSH's in-process jobs do not survive the host process restarting.

### Sources inspected

- This repository's `src/bridge.ts`, `src/adapters/chatgpt-web/index.ts`, `src/adapters/chatgpt-web/turn-broker.ts`, `src/adapters/chatgpt-web/markdown.ts`, and focused tests.
- Installed DSH `@deepseek-ai/dsh-acp/lib/index.js` and `@deepseek-ai/dsh-acp/README.md`.
- Installed DSH `@deepseek-ai/dsh-tool-bash/README.md` and `@deepseek-ai/dsh-jobs/README.md`.

### Queued browser admission (local source change, not deployed)

The native-session registry now uses `ChatGptBrowserAdmission` in `browser-admission.ts` to enqueue new owners rather than rejecting the sixth request. Admission is FIFO with five physical slots, 256 maximum waiting requests, AbortSignal removal, and idempotent release after the registered session's **physical** browser/launcher settlement. Existing native sessions are replayed without consuming another lease; owner identity and pending retirements are rechecked after a queued waiter obtains a slot. `browser-worker.ts` retains its hard five-active-run guard as a secondary defense, and `ManagedConversationPool` still limits retained browser pages to five.

This is not a promise of unlimited concurrent browser tabs: up to five turns execute physically while additional turns wait (until the finite queue is full). Queue waiting preserves in-process observer heartbeats through the adapter's existing interval. The change has focused FIFO, overload, cancellation, physical-settlement, and sixth-owner tests in `tests/browser-admission.test.ts` and `tests/browser-session-admission.test.ts`. Live stress testing under launcher helper/T3, process shutdown behavior, browser-worker exceptions, and long queue fairness still need verification. No running host process was restarted, and no installed bundle was replaced.

### Diagnostics evidence boundary

A read-only enumeration on 2026-11-07 found 207 diagnostic JSON snapshots in 10 trace folders, plus PNG evidence. String occurrence counts within snapshots are **not event counts**: duplicated page metadata and error text across lifecycle snapshots make them unsuitable for calculating failure frequency or identifying a compaction root cause without correlating per-trace terminal outcomes. Existing observations of transient network failures, lost response DOM, retired capabilities, and approval locator timeouts therefore remain distinct hypotheses pending a correlated timeline.

## Verification and operational safety

Run `bun test`, `bun run typecheck`, and `git diff --check` before handoff. Avoid `bun run build` into hard-linked installed `lib/` bundles or restarting the sidecar while another DSH/TUI session uses it without coordinating a safe drain. No active services need modification for a source-level review or test.
