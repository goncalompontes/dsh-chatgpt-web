# False context overflow in a retained ChatGPT chat

At 11:03:05 UTC, TUI session `8cd6b8d0-cafa-4c90-a427-87c9c5746e60`, turn 8 step 41, received a complete 2,857-character final answer (browser trace `e98ee21b78c4`). The adapter reported 96,731 estimated input tokens by compiling the entire canonical DSH history. The browser had actually reused the session chat and submitted a 7,653-character follow-up. pi-ai's silent-overflow detector rejected the successful `stop` because that history estimate exceeded the configured 90,000-token window.

Automatic recovery pruned old tool results, then failed compaction preflight at 92,720 estimated input tokens (`3fa46dc0d094`). Replaying the completed answer reported another full-history estimate above the limit and failed again. This was neither an authentication failure nor a ChatGPT rejection.

## Accounting

Automatic browser requests now estimate input from the compiled prompt actually selected by the browser worker. An exact retained successor counts its follow-up; a fresh chat counts the canonical replay. Tool continuations estimate only the MCP result payloads delivered in that round. Terminal and reconnected responses retain this accounting instead of recompiling unsent history.

Responses usage preserves `estimated: true` and adds `input_tokens_scope: "browser_submission" | "tool_results"`. These numbers describe observable input transported for the current exchange, including the existing conservative platform reserve on browser submissions. They are **not ChatGPT's retained context size**: the web product does not expose that value or its internal compaction state. Existing clients may ignore these extension fields, so their context gauge remains an estimate, not an authoritative percentage of ChatGPT's memory. Real composer, model, and transport preflight gates remain enforced.

## DSH compaction

DSH's text checkpoint request first attempts a read-only summary in the retained chat, guarded by the same exact canonical predecessor fingerprint as normal continuation. This consumes no work-tool capability. The compaction request keeps its separate execution owner while looking up the source session's conversation key.

If that exact chat is unavailable, canonical compaction uses fresh read-only requests. Oversized source text is divided without dropping any source characters, each fragment is summarized, and ordered partial checkpoints are merged. Images remain attachments and contribute separate summaries. The model/account composer gates still apply, with output headroom reserved for checkpoints. Recovery is bounded to four reduction levels and 64 browser requests, and fails explicitly on cancellation, an empty result, or nonconvergence. Only the completed merged checkpoint is returned to DSH; partial summaries never replace the session journal.

Tests cover a retained successor with canonical history over 90,000 tokens, exact retained compaction and unavailable-chat fallback, two sequential real broker invocations, usage extensions through terminal SSE, oversized records/Unicode/images, cancellation, and bounded failure. The original session journal is left intact.

## Live verification

The updated sidecar was loaded using the authenticated drain/shutdown handshake only after both HTTP and browser activity reached zero. The TUI, desktop host, gateway and router processes remained running.

An Instant headless DSH run executed two sequential connector calls through the installed DSH Code Mode plugin, running `echo CONTEXT_FIX_ONE` and `echo CONTEXT_FIX_TWO`. Both exited 0 and the final answer completed. A subsequent headless request resumed the saved DSH session and recalled both outputs. The connector results reported 194 estimated input tokens each instead of recompiling history.

A separate synthetic compaction request exceeded Instant's 41,000-token replay limit. It processed two fragments (31,260 and 31,127 estimated input tokens including the platform reserve), then merged their summaries. It completed in 50.71 seconds, preserved both the oldest constraint and latest next step, and emitted `response.completed` and `[DONE]`.

That validation also exposed a separate renderer bug: Turndown's server DOM returns `undefined` for a missing code source, while our source guard checked only for `null`. A legacy code wrapper could therefore crash while collecting a completed answer. The guard now handles both representations, with regression coverage. Compaction also suppresses the normal Pure Chat commentary so that the checkpoint contains only its summary.

## ACP recovery after an interrupted browser turn

T3's ACP session `587aaa53-6c22-4259-962a-b2321a9e5e9f` hit a different overflow after interruption. Its fresh browser replay contained about 701,000 characters; both the original request and automatic compaction exceeded GPT-6 High's 90,000-token preflight limit. The ACP profile had inherited provider settings but did not load this plugin, so the `llm-pi-ai/request-headers` hook never marked the compaction request. Tools remain advertised by native DSH compaction for cache reuse, so their presence cannot identify an ordinary task.

The ACP and headless profiles now include the plugin. Already-running hosts are supported by recognizing the exact SHA-256 fingerprint of DSH 0.2.2-rc.1's complete final-user compaction directive. That compatibility path selects text checkpoint recovery and strips tool capabilities, while ordinary requests to compact, quoted templates, and explicit other request purposes are unaffected. New DSH versions should send the purpose header rather than depend on the pinned template.

The bundle patch also overrides DSH's `compaction-basic` row with a small 4,096-token budget and `chatgpt-web/gpt-6-light` as its summarization target. This applies to fresh ACP/headless profile composition, so High work turns are compacted by the Instant route before their replay can exceed the browser's 120,000-character composer boundary. The `/v1/responses/compact` endpoint adapts the resulting text checkpoint to DSH's replacement-history response shape.

Native DSH's framed `<compacted-summary>` checkpoint is treated as background context. Its hash changes execution, retry, and retained-conversation epochs so retrying the original human prompt cannot replay the pre-compaction cached failure. The current user instruction remains the turn identity.

Validation: 76 tests and TypeScript checking passed. A server-to-adapter regression reproduces an oversized metadata-free ACP request, performs bounded compaction through the browser interface, and successfully retries the same instruction. A separate local replay of the affected session's saved history also passes: four source fragments (about 58,000–62,000 estimated input tokens each), then a merged checkpoint. These regressions simulate browser answers; private session history is not committed as a fixture.

The explicit `bun scripts/smoke-acp-compaction.ts` live check uses an isolated browser, copied login state, synthetic history, and the native headerless request with advertised tools. GPT-6 Instant summarized four fragments (about 25,000 estimated input tokens each) and merged them in 73.10 seconds. It preserved the oldest constraint and latest next-step markers, returned a text checkpoint, and executed no work tools. The copied credentials were removed during cleanup; shared sessions and their broker remained untouched.

## Compaction model selection

The first ACP recovery implementation kept the requested work model for every summary fragment. That is safe but too slow for High: DSH's one compaction request waits for all map/reduce fragments, while pi-ai's stream idle deadline is 300 seconds. The sidecar could still be working when DSH abandoned the request and replayed the original `context_length_exceeded` error.

DSH text compaction now selects the Instant/low-effort route from the same model family (`gpt-6` for GPT-6 and the Sol backend for GPT-5.6). The user's selected High/Medium model remains unchanged for normal work and tool continuations. Preflight sizing also uses the compaction route's limits. This keeps summaries bounded and fast without executing work tools.

The transport now also converts compaction-only adapter heartbeats into valid, invisible reasoning stream chunks. The prior `response.heartbeat` SSE was intentionally ignored by pi-ai, so it did not reset pi-ai's idle watchdog. The progress item is omitted from the completed Responses output; only the single synthetic compaction checkpoint remains.

The first progress item was reasoning-only; pi-ai's compaction assembler did not treat that as sufficient progress. It now uses an invisible text delta, which the assembler consumes while preserving the same one-checkpoint output contract. A direct pi-ai parser regression covers the full SSE sequence.
