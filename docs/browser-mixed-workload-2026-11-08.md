# Mixed document and PNG workload

`scripts/smoke-browser-mixed.py` runs a longer document response concurrently with
the existing Python-sandbox PNG export smoke. It requires idle HTTP/browser turns
and an empty admission queue, uses isolated session IDs, samples descendant RSS
every two seconds, and retains responses and resource observations under `/tmp`.
It does not restart services or change admission policy.

Live evidence: `/tmp/dsh-mixed-load-mbu6wnv0/`.

- Both responses completed, with an observed peak of two active browser turns.
- The document retained all eight numbered sections and its final marker:
  23,870 Markdown characters, 3,234 whitespace-separated words. The model exceeded
  the requested 1,800–2,200 words; this check asserts response size and completeness,
  not precise model word-count compliance.
- Chart session `media-smoke-06cb68de-e3dc-4bca-999d-9301f2ad6c0a` exported a
  1,342-byte PNG at
  `/home/pontes/.dsh/storages/chatgpt-web/artifacts/7eef4988-4a3d-40de-8342-7a5a6ffa9560-blue-circle.png`.
- Across 39 samples, summed sidecar-descendant RSS peaked at 4,697,165,824 bytes
  (4.37 GiB). No admission queue formed. Capacity remained five.
- Final health showed zero active HTTP/browser turns and no pending admissions;
  sidecar PID remained 2419045.

The initial validator rejected Markdown-escaped heading periods and underscores
in the final marker. It now normalizes standard Markdown punctuation escapes.
The saved response passed revalidation; removing its marker still fails. No model
requests were replayed. The initial report is retained alongside the corrected
report. The first script version did not persist the document session ID.

This broadens evidence beyond tool round trips. It does not establish memory
costs for arbitrarily large input documents, native image generation, live inline
authenticated image fetches, or saturated mixed workloads. RSS sums shared pages
and retained pages, so it is not incremental per-turn memory. Keep the existing
five-turn cap, 4 GiB reserve and 3 GiB allowance.

Repository CLI/plugin hashes match the web and TUI installations; ACP links to
the checkout. CLI SHA-256 remains
`b89242ccc4b067a3dc172141e77f0d443f8d67c93f2ce67f9933129fe7de4363`.
This batch changes diagnostics and documentation only; no runtime restart is needed.
