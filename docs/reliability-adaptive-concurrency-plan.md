# DSH ChatGPT Web reliability and adaptive concurrency — execution plan

Date: 2026-11-07
Checkout: `/home/pontes/projects/dsh-chatgpt-web`
Scope: Source development, diagnostic analysis, staged verification. **Do not mutate installed/hard-linked bundles, interrupt agents, restart sidecars, or discard existing dirty files.**

## Baseline

- Existing FIFO physical-turn admission: five active leases, 256 waiting, abort-aware, released on physical settlement. Test coverage exists; live deployment not established.
- `ChatGptTurnSessions.getOrCreate` and `ChatGptBrowserWorker.run` still contain five-turn defensive checks. The latter must not be relaxed without measuring real worker capacity.
- No proven connection between post-compaction replay and the observed two approval-locator timeouts. Distinct incident categories: approvals, DOM loss, DNS, disconnect, capability retirement.
- Current ACP profile declares `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-acp-app`, `@wlv-zedd/dsh-chatgpt-web`. The separate `dsh-tui` profile installs `dsh-better-goal@0.4.0`, `dsh-ptc-moejs@0.2.2`, and `dsh-pkexec-elevate-local` (local linked package). An attempted read-only `dsh --profile acp --dump-config` failed with EROFS because the DSH launcher writes `cordis.yml` during preparation. Do not bypass sandbox permissions silently.
- Host baseline at observation: 31 GiB RAM, 17 GiB available, 47 GiB swap (under 1 GiB in use), 32 logical CPUs, load ~2.85. This is **one sample**, not an empirically calibrated browser memory budget.

## Phase 1 — Evidence-grade incident analysis

1. Build a read-only diagnostic extractor that normalizes each trace into timestamped events: compaction epoch/trimmed context, native owner and round keys, broker registration/claim/delivery, outstanding tool IDs, permissions, response DOM transitions, physical settlement, and terminal state.
2. Deduplicate snapshots and missing/rotated diagnostics; reconcile file inventory discrepancies. Produce counts of unique *turns* and *failed turns* with denominators and sample windows.
3. Explicitly classify each incident as post-compaction resume failure (proven/suspected/unsupported), approval locator failure, DOM loss, network/DNS failure, disconnect, or unknown; preserve evidence links in a report.
4. Create deterministic reproduction fixtures for any confirmed state-machine bug. Do not change recovery policy from an unproven hypothesis.

**Exit:** Reproducible timeline, quantified incidence, and a repair-layer recommendation with evidence.

## Phase 2 — Safe targeted recovery

1. Repair only demonstrated lifecycle faults in DSH native session, ACP adapter, bridge, broker, or browser worker. Keep identity and call-ID invariants.
2. Add finite, signal-aware retry for transient browser observation/approval UI *only when idempotency and outstanding tool-call state are known*. Never replay a command that might already have executed or fabricate a tool result.
3. Ensure owner-retirement barrier, capability invalidation, and physical settlement precede new browser ownership. Test disconnects, compaction, cancellation, duplicate and late results.

**Exit:** Every fix has a regression test and trace proving safe terminal behavior.

## Phase 3 — Resource-adaptive browser concurrency

1. Keep fair, bounded FIFO admission and cancellation; introduce `setCapacity` or equivalent dynamic lease control. Capacity reduction only stops new admissions; it never preempts active leases.
2. Separate three dimensions: physical active turns, retained idle pages, and queued logical requests. Do not assume pages cost the same as active turns.
3. Sample host available memory, CPU pressure/load, effective cgroup memory ceilings, and browser/launcher RSS when accessible. Use OS-neutral input interfaces and Linux sampling for production; fail closed to conservative configured defaults on unavailable metrics.
4. Use configurable min/max and memory reserve, estimated incremental turn RSS from measured runs, and CPU headroom. Include smoothing and hysteresis/cooldown to avoid oscillation. Scale *up only after sustained headroom*, down on credible pressure; never promise more physical concurrency than validated launcher/browser support.
5. Export capacity, active/pending, pressure reason, queue latency and failure metrics; use synthetic pressure/time-series tests.

**Exit:** Empirically justified cap, no oversubscription during pressure, no lease leaks, no starvation.

## Phase 4 — Stress and integration verification

- Stress: >5 logical agents, FIFO admission, cancellation before/after slot acquisition, owner-race, sustained queue, shutdown, browser failures, reconnect, and resource shrink/growth.
- ACP/T3: capture genuine `session/update` events; verify tool names, kinds, call IDs, start/terminal metadata, approvals, rich Markdown fallback, concurrent/out-of-order results, background jobs and session resume.
- Keep installed ACP presentation compatibility patch opt-in until client/adapter layer is conclusively identified and a safe maintenance window is approved.

**Exit:** `bun test`, `bun run typecheck`, `git diff --check` pass; integration matrix recorded with actual evidence and limitations.

## Phase 5 — Review and rollout

- Review dirty tree ownership; avoid merging unrelated modifications.
- Commit only isolated intended changes after secret scan and review.
- Stage an inactive/test ACP instance for live integration before any shared deployment. Coordinate an agent-drain window before changing installed bundles or restarting services.
- Document rollback, config defaults, capacity safety limits, and known unsupported browser-rich content.

## Profile setup pending

The requested ACP profile needs plugin dependencies and ordered bundles for `dsh-better-goal`, `dsh-ptc-moejs`, and `dsh-pkexec-elevate-local`, matching the known-working `dsh-tui` profile. Changes are outside the workspace-write file sandbox and a profile restart would impact active sessions. Prepare the exact edits and install only through an approved privileged operation or a coordinated change window. Avoid duplicating an existing `Goal` with a new unrelated goal record.
