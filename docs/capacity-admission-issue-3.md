# Issue #3 — capacity admission fairness and queue latency

## Reproducible baseline (fork/main `034f3d8`)

`bun test tests/browser-admission.test.ts tests/browser-capacity.test.ts` passed **18/18** tests (318 assertions). The new queue-latency regression failed against this baseline because `metrics()` exported only lifetime total/max queue waits, with no distribution/percentiles. Existing FIFO scheduling, a bounded 256-request queue, cancellation, and immediate shrink were already covered by passing tests; no measured scheduling defect justified changing the FIFO policy.

## Scoped change

`ChatGptBrowserAdmission.metrics()` now exports `queueWaitSamples`, `p50QueueWaitMs`, `p95QueueWaitMs` and `p99QueueWaitMs`, calculated with nearest-rank percentiles over the **last 256 successfully admitted queued turns**. Aborted and rejected requests never contribute latency samples. The history is a fixed-size ring (at most 256 numbers); percentiles sort a copy only when metrics are requested. `totalQueueWaitMs` and `maxQueueWaitMs` remain lifetime values, so historical dashboards retain their meaning. Immediate admissions are not queue-wait samples.

This is an **observability-only improvement**, not a claim of reduced queue latency or increased throughput. It makes tail latency measurable without unbounded memory growth. Synthetic timings are injected through the existing clock seam; they are deterministic, not production wall-clock benchmarks.

## Before/after evidence

| Scenario | Before | After |
| --- | --- | --- |
| Original focused tests | 18 pass | 18 pass |
| New percentile regression | Fails: metrics absent | Passes; queued waits 10/20/40/100 ms, p50=20, p95=p99=100 ms, 1 cancellation and 1 overload excluded |
| 300 sequential queued admissions | No recent-window distribution | 256 retained samples, 44 old 1 ms waits evicted, p50/p95/p99=10 ms; no slot leak |
| Invalid/healthy CPU-memory samples | Not covered by this exact sequence | Passes alternating-pressure reset test |
| Full suite | Not rerun on baseline | 149 tests, 0 failures, 1,095 assertions across 27 files |
| `bun run typecheck` | N/A | Pass |

## Fairness, overload and pressure audit

The current admission queue is strict FIFO for surviving queued waiters and bounds pending requests by `maxPending`. Aborted requests are removed synchronously; capacity reduction never interrupts active leases; capacity increase drains in FIFO order. The existing saturation test drives 256 waiters, cancels 32, checks exact order and no leak. The capacity controller returns its minimum on missing/invalid host samples and resets healthy-sample streaks after pressure. The new tests cover a resource-pressure sequence and a separate fixed-size latency history under sustained requests.

## Limitations and risk

- Percentiles represent **recent completed queue waits**, not all requests, in-flight queue age, service latency, or a sliding time window. `queueWaitSamples` indicates the sample count; interpret 0 as no completed queue-wait observations.
- `metrics()` allocates/sorts at most 256 numbers per call, O(256 log 256); no new work is performed on immediate turn acquisition. No scheduler policy or resource-estimation constants changed.
- This suite simulates pressure/cancellation. Browser-account throughput and end-to-end p95/p99 remain environment-dependent and require a dedicated controlled live load run. Running such a test against shared authenticated sessions was intentionally avoided.
- `bun install --frozen-lockfile` was necessary in the isolated worktree before typechecking; no dependency manifests were modified.

## Reproduce

```sh
bun install --frozen-lockfile
bun test tests/browser-admission.test.ts tests/browser-capacity.test.ts
bun test
bun run typecheck
git diff --check
```
