# Live ACP, compaction, load and media validation

Follow-up to `acp-reliability-goal-2026-11-08.md`. The overall reliability goal remains active.

## Native compaction and transport recovery

`scripts/smoke-acp-lifecycle.py --scenario compact --timeout 300` now runs native DSH
maintenance compaction inside an isolated ACP host. The test-only overlay in
`scripts/fixtures/dsh-lifecycle-observer.mjs` exposes a private Unix socket for that
host's own session; production profiles never load it. DSH overlays require an
`insert` patch for a new plugin entry, rather than an ID-only override.

Two live sessions passed:

- `22c40301-58a3-480d-8d34-419ab7a44e34`: committed five shadowed history items,
  summary sequence 26; a subsequent native bash tool completed and returned the marker.
- `3773fe3e-0493-4a99-a497-f5f931901d56`: repeated the check with explicit event-level
  correlation. The observer checks checkpoint commit order, matching post-checkpoint
  tool-call/result IDs, successful tool status, and final ACP completion.

`--scenario reconnect` closes the entire ACP transport without `session/close`, then
starts a fresh DSH host and resumes the persisted session. Session
`c07a06f9-b02f-4bbb-943e-c10fcc48e2da` passed (host PID 1731080 → 1737035), with one
successful bash tool before disconnect and another afterward.

The separate `compact-active` scenario reproduced a deadlock in session
`6b7556ab-12d4-43ad-86ac-13193b01de3a`: native bash had finished, compaction committed
at sequence 39 in turn 2, and the next provider request waited for the old browser
execution. That browser was still waiting for the pre-checkpoint tool result, which
could no longer reach it. Traces were `8014a2d52ef8` (waiting browser),
`7532a0497e6a-compact-1` (checkpoint) and `bc4a3fadc2c6` (blocked continuation).
Evidence is `/tmp/dsh-compact-active.log` and
`/tmp/dsh-acp-smoke-bu0bbgo8.log.events.jsonl`.

The adapter now retires the old execution only for the same exact native thread,
turn and owner when its checkpoint epoch changes. It revokes the old capability,
waits for physical browser settlement, then admits the new execution without
replaying the delivered tool. Superseded requests are rejected; cancellation of the
request initiating retirement does not lose that protection. Same-epoch steering
and other native turns retain sequential admission.

A first live recheck stopped before this transition: DSH rejected its generated
summary as larger than the tiny source history (646 >= 583 framed tokens). The
smoke now seeds enough compressible history to exercise checkpoint recovery.
That failure also exposed an orphaned waiting browser after a native error. The
plugin now forwards unsuccessful native termination (`error`, `blocked`, and
`max-tokens`, alongside `aborted`) to the exact-turn interrupt endpoint. Completed
turns and unrelated providers do not trigger interruption.

The seeded recheck (`8a82b69d-351c-4afe-9914-d0addfafba9f`) committed a seven-item
checkpoint and finished the turn, confirming the deadlock was removed. Its stricter
exactly-once assertion caught model replay: the replacement called bash again before
reading README. The checkpoint summary described bash as pending, while the later
canonical tool result proved it had already finished. The fresh-chat transport had
still said to execute the latest request. It now explicitly resumes from recorded
tool results and states that later results supersede a summary's pending-work list.
The model may still retry when evidence or the task requires it; identical arguments
are not globally blocked or cached across independent calls.

The corrected live recheck **passed** in session
`a9054b1b-cfbe-42f9-b378-9a917db8312b`: checkpoint summary sequence 37 shadowed seven
items, commit sequence 39 occurred in turn 2, and the replacement performed only the
remaining read. Turn 2 contained exactly one bash and one read, both successful;
the final answer contained `DSH_ACTIVE_COMPACT_OK`. Post-checkpoint call/result IDs
matched. The original trace `a86ed93670b2` physically retired before replacement
`2c3c21ae8d72`; compaction trace was `789b1fa2a95f-compact-1`. Evidence is
`/tmp/dsh-compact-active-resume.log` and `/tmp/dsh-acp-smoke-e_hx2094.log.events.jsonl`.

`--scenario native-failure` injects a test-only pre-step failure immediately after a
native tool result. Session `3eafadaf-fd7e-45c1-9fc6-5858bff290fa` passed: its expected
`DSH_SMOKE_INJECTED_NATIVE_FAILURE` ended turn 2, and turn 3 ran one bash call and
returned `DSH_NATIVE_RECOVERED`. This exercises producer error cleanup between HTTP
rounds, rather than only cancellation of an open stream. Evidence is
`/tmp/dsh-native-failure.log` and `/tmp/dsh-acp-smoke-43jpgbm6.log.events.jsonl`.

## Queued browser admission under load

Six independent ACP hosts each executed exactly one read-only command:
`sleep 30; printf DSH_ACP_OK`. All six completed their tool and final answer successfully.
No existing user sessions were active. The admission policy was unchanged throughout.

The 120 two-second RSS/health observations recorded:

- Five simultaneously active browser turns, never exceeding the physical cap.
- Three pending turns at peak; the queue drained to zero.
- Maximum individual admission wait: 69,955 ms.
- Total admission wait: 219,299 ms across the observed run.
- Maximum sidecar-descendant RSS: 4,240 MiB; retained idle pages accounted for much
  of the baseline (up to 3,998 MiB at zero active turns).

This supports the conservative 3 GiB per-turn admission allowance on this 32 GiB,
32-CPU host; the five-turn allowance plus 4 GiB reserve exceeds this measured peak.
Summed RSS counts shared pages more than once, and the workload is a small tool
round trip, not a large-document or image-generation stress test. It does not establish
an incremental memory cost for every browser turn. Keep the cap and reserve.

The per-client evidence is under `/tmp/dsh-admission-load-13tpc5vd/`; observations are
`/tmp/dsh-admission-load-rss.jsonl`. `scripts/smoke-browser-admission.py` packages the
same six-client check and resource sampling for future explicit live runs.

Transient ChatGPT profile-check network failures occurred during the live checks.
The native clients eventually succeeded; no login state was reset to recover them.

## Media export

The adapter exports supported images and explicit generated-file downloads from the
bound final reply. It appends local Markdown links after the prose, preserving the
append-only response stream. Files are private and use sanitized unique filenames.
Persistent exports are capped at eight assets per reply, 8 MiB per saved asset and
512 MiB total storage, without deleting files already referenced by earlier replies.
Browser download temporary storage is removed after reading or rejection.

Authenticated image reads use the page's same-origin credentials, a streaming size
cap, verified raster signatures and trusted ChatGPT/media origins. Generated files
use the browser's actual download stream. Cancelling a download and re-fetching its
URL failed against the live workbook UI, whose blob URL may already be revoked.
The regression now includes immediate blob revocation after the download click.

The current ChatGPT workbook renderer exposes a Download file button, rather than
only a `sandbox:` anchor. Both forms are recognized. A real live CSV export passed
in `media-smoke-49ede296-e653-469e-8db7-f072be5f20ed`; its exact 29 bytes were checked
against `key,value\nsmoke,DSH_MEDIA_OK\n`, and the response contained a local artifact
link. No workspace file was fabricated as a substitute for the browser download.

The Chromium tests also verify authenticated image bytes, reply isolation, download
buttons, filenames and permissions, oversized/disguised image rejection, cancellation,
and explicit fallback when an attachment cannot be exported. Unsupported widget
interactivity stays in ChatGPT; its semantic text, math and labelled visuals remain
in the response where available.

## Parallel calls

Both light- and high-effort live models issued the requested independent reads
serially. Those runs are not evidence of overlapping model dispatch. The real-socket
broker regression now covers three concurrent calls completing out of order, including
a failed call alongside two successful calls, while preserving original names and IDs.
The limitation in the live model-driven overlap check remains explicit.

## Verification and installed artifacts

The latest full regression run passed **127 tests, 0 failures, 962 assertions across
24 files**. TypeScript checking, build, whitespace checks and the clean-tarball smoke
passed. All Python smoke scripts parse and the observer fixture passes Node syntax
checking. The clean tarball installs and starts the CLI and doctor, resolves its
dependencies, and contains no build-environment paths.

The ACP, web and dsh-tui profile CLI/plugin artifacts match the repository build;
their files share the repository artifact inodes. Current SHA-256 values:

- CLI: `6358f00e10892e7ba85c62f70f5c1ebf2a09c31c8b676a606f0a247bfc1e47d0`.
- Plugin: `ca4035a0867bc4c719f26d7329be146280c54ce04aac9b8580cef5845b8fa958`.

Deployment used authenticated drain/shutdown after zero active HTTP/browser turns
and no supervisor clients, then verified that the previous process exited before
ensuring a healthy replacement. No real user session was interrupted. Gateway and
router code was unchanged. The sidecar's current version string remains 1.0.5;
the hashes above identify the updated build precisely.

## Remaining scope

- A live model-driven overlapping dispatch; current model runs chose serial calls.
- T3 UI rendering confirmation beyond the passing native ACP name/kind checks.
- Live authenticated generated-image export; real generated-file export and browser
  image fixtures pass. Unsupported interactive widgets still require ChatGPT.
- Broader resource workloads beyond the measured six-client tool round trip.

The overall goal remains active. The reproduced active-turn deadlock, repeated
post-checkpoint command in its smoke, and native-error orphaning now have fixes
and successful native live checks.
