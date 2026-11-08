# Measured browser turn concurrency

The previous adaptive policy never supplied its optional measured per-turn RSS
input and independently capped admission and physical workers at five. The new
shared ceiling defaults to 32 and can be set with
`DSH_CHATGPT_WEB_MAX_TURNS=1..128` in the sidecar launch environment. A ceiling is
not a reservation: capacity still starts at one and depends on available resources.

On Linux/WSL2, the sampler reads this sidecar's descendant process RSS and CPU
ticks every ten seconds while active work or waiters exist. It identifies process
generations with PID and start time, excludes guest counters from host CPU tick
totals, and tolerates processes exiting during observation. It does not attach to
unrelated Chrome sessions. Native tools outside this process tree still contribute
to host pressure even though they cannot be individually attributed to a browser turn.

Idle retained pages form the memory baseline. After twenty seconds at a stable
active count, incremental RSS and process CPU usage are divided by that count and
given a 25% margin. Recent peaks decay with a ten-minute half-life. RSS sums shared
pages, so this is a conservative workload estimate, not calibrated private memory.
The policy applies floors of 512 MiB and half a CPU core per turn; cold startup
uses 3 GiB and one core. It keeps the existing 4 GiB memory reserve and 75% CPU
budget. Missing host metrics restrict capacity to one; missing process measurements
fall back to the host policy and cold-start costs.

Within a busy period, cost learning pauses below its high-water active count, so
departed turns' retained pages cannot inflate the cost of the last running turn.
Memory credited to active work is capped by the learned per-turn footprint. This
also prevents retained pages from being treated as reclaimable active memory.

Resource availability already excludes running browsers. The estimator credits
only their observed incremental usage when calculating total supported capacity,
avoiding a second charge for current work. Idle retained memory receives no such
credit. Capacity grows by one after three healthy observations, with at least
thirty seconds between increases, and reduces immediately under observed pressure.
Reductions affect future admissions; running turns are never preempted. Excess
work waits in the existing cancellable FIFO queue, bounded at 256 waiters.

`/healthz` reports `browser_admission.maxCapacity` and the last sample under
`browser_admission.resources`, including active count, process-tree RSS, incremental
workload RSS, available memory, CPU count/load and learned per-turn costs. Learned
costs are reported before policy floors. Samples are ten seconds apart, so the
sample's active count can differ from the current admission count.

Verification: **143 tests passed, 0 failed, 1,053 assertions across 26 files**;
typecheck, build, whitespace and clean-tarball checks passed. Regression coverage
includes learned costs above five turns, memory/CPU pressure reduction, idle
baseline handling, peak retention, recycled PID counters, shared ceiling
validation, cancellation, and waiting for physical settlement before reusing a slot.

The supervisor had already stopped idle sidecar/gateway workers with no clients
before deployment. `stack.py ensure` started updated sidecar PID 2561594 and
gateway PID 2561595; router PID 1359 was unchanged. No active session was interrupted.
After the retained-page accounting regression was fixed, the final build used
authenticated drain/shutdown at zero active turns, no queued requests and no DSH
clients. The previous sidecar exited before replacement PID 2593837 started.
A fresh native ACP load smoke passed on that final build in session
`ba321b6d-2c0a-4558-a9c8-c7b19a3c27e4`, with one completed bash call and final marker
(`/tmp/dsh-measured-capacity-final-acp.log`). Final health reported zero active
HTTP/browser turns and no pending admissions. Final CLI SHA-256:
`cdb39f21eb1e6b266c25d7e4392bc6ac81be06c73859eec5b760ea3f847e4d06`.

## Live evidence

The first workload used eight isolated ACP clients with 180-second read-only bash
calls (`/tmp/dsh-admission-load-ebgup142/`). It observed six simultaneous browser
turns, a seven-request queue, capacity increasing to nine, and peak descendant RSS
of 4,942,774,272 bytes. It failed end-to-end: seven clients received submitted-turn
errors following connector invocation disconnects/browser aborts while the long
native tools were running. One client passed. Resource admission itself stayed
healthy and drained the queue, but this is not a passing tool-lifecycle check.
The smoke retains the failed result and per-client logs; no original tool was
replayed. Normal-duration calls are checked separately to avoid interpreting long
connector wait failures as evidence of insufficient hardware.

The normal-duration follow-up passed **12/12 isolated ACP clients**, each using
one 30-second read-only bash call and its final marker. Evidence is
`/tmp/dsh-admission-load-unnlvn3w/` and
`/tmp/dsh-measured-capacity-normal-live.log`: 54 samples, eleven simultaneous
browser turns, two queued requests, and peak descendant RSS 9,086,820,352 bytes
(8.46 GiB). Capacity reached thirteen. The displayed maximum queue wait in this
report is cumulative since service startup and includes the earlier long-call run;
it is not a per-run wait measurement. All test hosts exited and final health had
zero active HTTP/browser turns and no pending requests.

This verifies queued native tool round trips above five. It does not establish
that every workload can sustain the maximum ceiling or that increased hardware
capacity removes upstream account, connector or caller timeout limits.
