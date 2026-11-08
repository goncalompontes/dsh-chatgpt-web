# Rich widget conversion corrections

The audit reproduced two missing-content cases directly in
`chatGptHtmlToMarkdown`:

- `<section aria-label="Roadmap"><h2>Release plan</h2><p>Keep this important paragraph.</p></section>`
  returned only `Release plan`. The map classifier matched the substring “map”,
  then summarized the section as a widget and discarded ordinary prose. It now
  matches a map word in accessibility labels and complete identifier components
  in test IDs and CSS classes. Roadmap, sitemap and bitmap sections retain headings and paragraphs.
- An iframe titled `Revenue explorer` disappeared entirely. Embedded frames now
  retain a bounded plain-text label and an explicit notice that interactive
  content remains available in ChatGPT. Unlabelled frames also get a notice.
  Frames with `aria-hidden="true"` or a `hidden` attribute remain excluded.
  Neither source URLs nor `srcdoc` markup are copied into Markdown.

Both regressions failed before the correction and pass afterward. Existing map
and carousel summaries still retain semantic place links and omit map controls.
The browser-level fixture also reproduced the matching extraction filter and
stale frame labels after a title change. Extraction now uses the same bounded
map identifiers, keeps iframe-only Markdown segments, and observes title
attributes when invalidating the DOM cache. The fixture checks the actual
snapshot segments and completion text, rather than only the converter in isolation.
This correction does not execute or export frame contents; interactive behavior
remains in the upstream UI. Labelled canvas/SVG capture is covered separately in
`media-visual-export-2026-11-08.md`.

Validation: **138 tests passed, 0 failed, 1,025 assertions across 25 files**.
Typecheck, build, whitespace and clean-tarball checks passed.

Deployment stopped only the idle host created at 12:55:11 for our completed
temporary tool-card test. Its thread had no active run or pending requests. No
other supervisor clients remained. Authenticated drain and shutdown both reported
zero active HTTP/browser turns. Each replaced sidecar was confirmed absent before
`stack.py ensure`; final sidecar PID is 2485778. Gateway and router were healthy
and unchanged. The installed web/TUI artifacts share the updated repository build.

CLI SHA-256:
`030ea9813b2d1154e62c94e61a27806dedf66ca87097b2a827d268035925e397`.

## Newly observed hydration rejection

An initial native ACP tool smoke passed in session
`331cfe2b-7d2c-4277-aca6-5724ef5af52a`. A later smoke failed after its read-only
bash tool had completed: trace `b7d68fc64b19` rejected an assistant rebind with
“ChatGPT opened another user turn while the bound assistant response was detached”.
The saved response-visible checkpoint had no user DOM roots; the failure checkpoint
had two raw user matches. Those counts do not establish two distinct messages.
The screenshot shows the submitted prompt in a collapsed bubble. Evidence:
`~/.dsh/storages/chatgpt-web/diagnostics/browser-turns/b7d68fc64b19-fdc8c62b/`
and `/tmp/dsh-rich-widget-final-acp-2026-11-08.log`.

The cause is not established. The guard still rejects competing input, and no
original tool was replayed. A new bounded diagnostic logs only the count of added
identities, whether the submitted user is still present, normalized prompt lengths,
and common-prefix length; it does not log prompt text or broker capabilities.
The browser regression suite still passes after this diagnostic addition.
A fresh isolated native ACP check on the final deployed build passed in session
`0d26fe9b-3c94-4889-99c4-b11c66f9cc32` (log `/tmp/dsh-rebind-diagnostic-acp-2026-11-08.log`).
This establishes a successful fresh tool round trip, not resolution of the earlier
intermittent rejection. Final health reports zero active turns and no pending queue.
