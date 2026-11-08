# DSH ACP turn failures and deployment — 2026-11-08

The latest generic `chatgpt_submitted_turn_failed` errors conceal browser submission failures. T3 run completion timestamps match the saved browser diagnostic timestamps; the retained screenshots and structured alert snapshots identify the actual messages.

## Evidence

- <t3-thread://v2/22dc85a4-1f2f-48de-93f3-f1f80482d218/8ffb2d4d-d99c-4ac2-8e54-51b60606b53f>: run 27 ended at 2026-11-08 01:37:19Z. Trace `01fccfa9a2fa` captured its failure at 01:37:19.588Z. The page displayed “The messages you submitted were too long, please edit them and resubmit.” The browser submission was estimated at 58,895 tokens and 182,094 characters. Run 26 ended at 2026-11-07 22:30:17Z; trace `7fe4506bf292` at 22:30:17.226Z displayed “Something went wrong. Please try again”. These are distinct upstream failures.
- <t3-thread://v2/22dc85a4-1f2f-48de-93f3-f1f80482d218/0f0b3c88-3e83-4eb2-961c-420fcda561b4>: run 16 ended at 2026-11-07 21:11:43.754Z. Trace `aef22ef827b3` failed at 21:11:43.727Z with the same too-long alert, after an estimated 70,151-token, 223,402-character submission.
- <t3-thread://v2/22dc85a4-1f2f-48de-93f3-f1f80482d218/mcp:0ba604bd-60d6-48ec-b912-23b38d4c6b14>: run 8 ended at 2026-11-07 21:14:52.177Z. Trace `b83c62b6fee9` failed at 21:14:52.145Z with the too-long alert, after an estimated 69,330-token, 233,193-character submission. An earlier compaction fragment (`740664187160-compact-3`, 21:13:43Z) separately reported competing user-turn identity; its relationship to this final submission is not established here.

The current supervisor writes to `~/.local/state/dsh-web-stack/sidecar.log`. The older `~/.dsh/storages/chatgpt-web/logs/sidecar.log` ends with earlier approval-selector failures and is insufficient for investigating these latest incidents.

## Correction

The browser replaces the assistant response with a sibling `role="alert"` inside `main`. Existing terminal-error detection searches the bound assistant node, so it misses the alert. The missing-response watchdog subsequently raises a DOM-disappearance error, which the adapter replaces with the generic submitted-turn failure.

Added explicit visible submission-alert detection during submission acceptance, initial assistant discovery, multipart acknowledgement, and response observation. The exact too-long alert now produces `context_length_exceeded`, preserving DSH's overflow/compaction recovery signal after submission. The observed generic upstream alert produces `upstream_server_error` without automatically replaying potentially delivered tools. Detection excludes hidden alerts, ordinary quoted text, unrelated notifications, and alerts outside the main conversation.

Regression coverage uses real Chromium DOM fixtures for the observed alerts and an adapter/Responses test to verify that a post-submission overflow keeps its code. Existing overflow recovery tests cover checkpoint generation and retrying the same human turn across a changed compaction epoch. They do not prove that every live oversized conversation will compact successfully; browser limits can reject requests that pass the local estimates.

Review also found a termination bug in pipe-delimited tool-result matching: JavaScript clamps a negative `lastIndexOf` position to zero, so an unmatched ID starting with `|` could loop forever. The prefix loop now stops before the empty prefix. The nested-ID regression includes an unmatched leading-pipe ID.

## Deployment

Reviewed and retained the existing external MCP integration, DSH session identity and text compaction, managed conversation retention, Markdown conversion, continuation matching, physical retirement cleanup, adaptive browser admission, and associated regression tests and incident notes.

Before rebuilding, the installed CLI and plugin bundles were dated 2026-11-07 13:49. The repository bundles are hard linked into the web and dsh-tui profiles; ACP links directly to this repository. Rebuilt both bundles at 2026-11-08 01:45Z and confirmed matching CLI SHA-256 across installed profiles:

`8c640d82c4f2bccf64314497c26fc71a4fe267c3c695001d40c0f5be7ee9936c`

Confirmed zero active HTTP/browser turns, restarted the stack supervisor, sidecar and gateway at 01:46Z, and terminated the idle T3 ACP host so its next connection loads the rebuilt plugin. Following the final pipe-ID correction, rebuilt and restarted the sidecar and gateway again; final sidecar PID is `1627262`, gateway PID is `1627263`. The existing router and T3 server required no code updates and remained running. The optional installed-DSH ACP tool-presentation compatibility patch remains opt-in; it has not been applied.

The first fresh native ACP verification initialized, selected `chatgpt-web/gpt-6-light`, executed exactly one read-only `bash` command (`printf DSH_UPDATED_ACP_OK`), received a completed tool result, and returned an `end_turn` answer. Its test assertion initially rejected valid Markdown underscore escaping in the returned answer; the service round trip itself completed. A corrected verification accepts that Markdown representation.

Final verification: **112 tests passed, 0 failed, 612 assertions across 22 files**. Build, TypeScript and whitespace checks passed. The final tarball passed clean installation, Node/Bun CLI startup, doctor startup, dependency resolution/loading, and build-path contamination checks. The corrected native ACP smoke returned `end_turn`, one completed tool, and the expected marker with valid Markdown underscore escaping. Final service health was healthy with zero active HTTP/browser turns, and the maintenance hold was released to restore normal on-demand operation.
