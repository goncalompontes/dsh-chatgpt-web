# Rendered media export follow-up

The final-reply exporter now saves labelled canvas and SVG visuals as PNG files
of their displayed pixels. This preserves chart and diagram geometry alongside
the semantic Markdown description. It uses the same private artifact store,
eight-asset reply cap, 8 MiB file cap and 512 MiB storage cap as image downloads.
Graphics must have an accessible label (or SVG title), render at least 64 by 64
CSS pixels, and fit within 4096 by 4096 pixels. Small icons and elements outside
the bound final reply are excluded. Oversized or unavailable captures produce
explicit fallback text; this does not export interactive behavior.

The audit also reproduced two silent omissions: an image from an unsupported
origin produced no export notice, and a ninth attachment was silently truncated.
The exporter now explains both cases without fetching unsupported origins or
raising the existing limits.

Real Chromium regressions verify byte-for-byte agreement between exported
canvas/SVG PNGs and captures of the displayed visuals, correct image dimensions,
reply isolation, icon exclusion, unsupported-origin fallback, and overflow notice.
Existing authenticated image and revoked-blob download coverage still passes.
Full local suite: **135 passed, 0 failed, 1,005 assertions across 25 files**.
Typecheck and build pass. Live native image generation remains restricted by
Temporary Chat; prior live chart downloads prove file export rather than the
authenticated inline-image fetch path. This follow-up does not claim a live
canvas/SVG emission from ChatGPT or direct rendered T3 UI verification.
