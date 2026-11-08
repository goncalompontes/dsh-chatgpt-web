# ACP reliability goal — progress and remaining validation

This follows `t3-turn-errors-2026-11-08.md` and the referenced investigation at
<t3-thread://v2/22dc85a4-1f2f-48de-93f3-f1f80482d218/8ffb2d4d-d99c-4ac2-8e54-51b60606b53f>.
The goal remains active. The fixes below do not establish that every remaining issue is resolved.

## Implemented

- Broker completion stores canonical SHA-256 result receipts until turn retirement.
  Repeated identical results succeed; conflicts fail. Remote owners retry result delivery
  up to three times on transport failure, never the original tool invocation. A real
  socket proxy test drops the first ACK after acceptance, including compaction and retirement cases.
  Pending calls plus receipts are bounded at 1,024 per channel without evicting retry receipts.
- Applied the installed ACP presentation compatibility patch to `@deepseek-ai/dsh-acp`.
  Start and completion events preserve names and kinds (for example `bash` / `execute`).
  Regression fixtures no longer depend on an unpatched installed bundle. The backup is
  `index.js.before-t3-presentation-patch` beside the installed bundle. Reinstalling DSH
  requires checking/reapplying this patch with `scripts/patch-dsh-acp-tool-presentation.mjs`.
- Fixed hydrated prompt matching: composer newlines become paragraphs, and a connector
  mention can render as plain text. Rebinding still requires the entire normalized prompt
  to match and rejects competing/additional human turns. Chromium regression coverage
  reproduces the former false rejection (`d37ec7fb82e1`).
- Rich extraction preserves picture images, image-only replies, labelled SVG/canvas
  descriptions, and KaTeX/MathML TeX annotations. DOM revisions observe changing image
  URLs/labels. Unsupported image data is not represented as downloaded bytes.
- Health exposes admission pressure and latency: active/pending, capacity, admissions,
  queued cancellations, overload rejections, total/max wait and oldest queued age.
  A saturation regression queues 256 owners, rejects overload, cancels 32 waiters, and
  reduces capacity from five to one without preempting existing leases or breaking FIFO.

## Newly reproduced background continuation failure

The first live background check (`00a51086f782`, session
`fda56f2d-a385-45a3-9462-0c4ae2327b0f`) started a job and read README.md.
DSH then projected its job-completion notice into a user-role message. That changed
the adapter's inferred human identity and opened browser trace `017ef25bce43`.
The new response tried the retired old broker capability, and returned the marker
without collecting `job_output`; the smoke correctly failed its lifecycle assertion.

The adapter now treats the exact DSH completion envelope as context only when a
preceding tool result started that specific job ID. Unknown job IDs, quoted notices,
and ordinary human steering retain their normal identity behavior. This workaround
does not grant tool or filesystem authority; pi-ai does not preserve inbox provenance.
Truncated producer notices and notices whose start record was compacted away remain
an edge case for a future structured producer-metadata integration.

The corrected live check passed: session `42bab26f-f827-4634-baab-3492400f20b0`,
trace `d92a0ec4e46b`, completed `bash`, `read`, and `job_output`, then returned the
expected final marker. All provider continuations kept the same identity.

## Cancellation and reconnect

Closing/resuming ACP session `0d769dc4-4ade-4fcb-bb65-f01d911eedcf` succeeded:
one bash tool before close and another after resume, with correct final markers.

Cancellation during tool delivery initially left the physical browser waiting while
the replacement turn waited for that owner to settle. The smoke eventually recovered,
but cancellation lacked an explicit provider-boundary notification between HTTP rounds.
The plugin now sends the producer's stable `dsh-turn-N` ID in request headers and
forwards aborted turn-end events to the existing authenticated, exact-turn interrupt
endpoint. It only forwards turns actually sent to this sidecar. Delayed interrupts
cannot cancel a newer turn or a different session. Headerless hosts retain the legacy
content-derived identity fallback.

The updated cancellation/recovery smoke passed in session
`8819ebfc-ae7f-4e85-a055-8718b18b0531`: original browser trace `697446dfaddf`
was explicitly aborted and replacement trace `1d7b6c47733e` completed the recovery
tool and marker. A second background check with producer turn IDs also passed in
session `f5393596-45dd-43e5-a4e1-7f2ba774cdcd`.

`scripts/smoke-acp-lifecycle.py` supplies isolated, read-only live scenarios for tool,
background, close/resume, cancellation/recovery and parallel dispatch. These checks
create their own DSH hosts and clean up only their own sessions. Parallel dispatch
has not passed the live overlap assertion: the model issued the two reads serially.
The real-socket broker and SSE tests do verify distinct parallel calls and identifiers.

## Resource observations

`scripts/measure-browser-resources.py` samples sidecar descendant RSS and correlates
it with admission counters. One active browser tree was about 1.9 GiB; a later
20-sample run observed 2,318–2,508 MiB with zero or one active turn and retained
conversation pages. RSS sums double-count shared pages; these are process-tree
observations, not calibrated incremental per-turn costs. The provisional 768 MiB
allowance is replaced with a conservative 3 GiB allowance. The hard cap remains five
and the reserve remains 4 GiB. Full concurrent peak-load calibration remains open.
The live two-session check also exercised queued admission: health reported three
admitted browser executions and 19,897 ms maximum/total queue wait, with no pending
or active turns after cleanup. This validates live metric wiring, not saturated load.

## Verification and deployment

Final regression run: **121 passed, 0 failed, 914 assertions across 23 files**.
TypeScript, build, whitespace checks and the clean-tarball smoke passed. The tarball
check includes clean installation, CLI/doctor startup, dependency loading, and absence
of build-environment paths.

The CLI and plugin artifacts match the ACP, web and dsh-tui installations (shared
files). CLI SHA-256: `b7662d259dd083efc6779dc172e8eeedcc22c39f5df15ac192ce47882e3eed30`.
Plugin SHA-256: `361a4ee7bda3450cb6525889c068b4174798b223774507926feafa53688fa1ba`.
The affected sidecar is updated via authenticated drain/shutdown only after health
reports zero active HTTP/browser turns and the supervisor reports no DSH clients.
The existing gateway, router and T3 service need no code changes for this batch.

## Still required for the full goal

- Verify the ACP presentation in the T3 UI, in addition to native protocol evidence.
- Downloaded artifact bytes, authenticated image export, and fuller interactive-widget handling.
- A live parallel dispatch with observed overlapping tools, broader mixed failure ordering,
  and reconnect after transport loss rather than only explicit close/resume.
- Live post-compaction reproduction and trace correlation. The reported timeout mechanism
  remains unproven; current tests cover checkpoint recovery and continuation identity.
- Concurrent peak-load resource calibration and a live queue/latency run under pressure.

Do not restart workers while any real ACP session is active. Use health counters,
supervisor leases, and targeted drain/shutdown; ordinary idle worker shutdown is expected.
