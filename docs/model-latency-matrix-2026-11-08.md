# ChatGPT Web ACP latency matrix — 2026-11-08

This extends [the two-sample startup measurement](model-startup-latency-2026-11-08.md)
with three repeated runs, three prompt shapes and bounded concurrency. The
headline is unchanged: **almost all latency happens after the browser accepts the
prompt**, not in local preparation. Two new results sharpen it:

- A retained conversation saves **9–23 seconds** per turn (paired medians).
- Adding **30,000 characters** of context to a no-tool prompt cost about **1 second**,
  so payload size is not what drives the 10–34 second post-submission wait.

[Chart](model-latency-matrix-2026-11-08.html) ·
[Data](model-latency-matrix-2026-11-08.json) ·
[Raw private evidence](/tmp/dsh-latency-matrix-2026-11-08/) ·
[Sweep log](/tmp/dsh-latency-matrix-run.log)

## What ran

71 turns against the live service in 54 jobs, with zero external turns during the
run. One concurrent turn failed (1.4%); the other 70 completed with the expected
one-tool or no-tool shape.

| Arm | Routes | Turns | Shape |
| --- | --- | ---: | --- |
| Serial read | all 6 | 36 | 3 runs × fresh + retained, one native `read` |
| Serial answer | GPT-6 L/M/H, Sol M | 9 | 3 runs × fresh, no tool, one-word answer |
| Serial long context | GPT-6 L/M/H, Sol M | 9 | 3 runs × fresh, 30,000 characters, no tool |
| Concurrent read | GPT-6 Light | 18 | widths 3 and 6, two batches each |

Method details:

- Three serial runs per route, reversing model order on every second run to reduce
  fixed-order bias. Run medians were 34.0s, 32.2s and 30.9s for fresh reads, so
  there was no upward drift across the sweep.
- Each ACP event is timestamped from the client side. Browser stage logs and
  `send-accepted` checkpoints are correlated by trace. `setup` ends at submission;
  `post-submit` is the rest of the turn, including the model wait, the tool round
  trip and the final answer.
- Long-context prompts insert a deterministic neutral paragraph before the same
  one-word task. They do not call a tool.
- The concurrency arm launched isolated ACP sessions simultaneously; it did not
  create T3 threads or change admission policy.

## Serial results

Seconds, median (observed range), three samples per cell.

| Route | Fresh total | Retained total | Fresh setup | Fresh post-submit |
| --- | ---: | ---: | ---: | ---: |
| Sol · Light | **26.9** (21.9–27.4) | **14.3** (13.0–18.7) | 4.0 | 22.9 |
| Sol · Medium | 31.5 (27.0–38.5) | 21.4 (15.4–50.1) | 4.0 | 27.5 |
| Sol · High | 33.9 (30.3–44.0) | 15.6 (14.1–37.2) | 3.9 | 30.0 |
| GPT-6 · Light | 27.1 (25.5–29.3) | 15.9 (13.5–24.6) | 3.9 | 23.2 |
| GPT-6 · Medium | 38.2 (34.0–40.3) | 15.2 (14.7–15.6) | 3.8 | 34.2 |
| GPT-6 · High | 37.1 (35.4–39.3) | 15.1 (15.1–33.2) | 3.7 | 33.4 |

Retained means the same ACP session and the same managed ChatGPT page; every
retained turn reported `reused=true`. Paired savings (fresh minus retained, same
session) had medians of 9.0s, 9.6s, 16.1s, 16.3s, 20.3s and 22.9s across the six
routes.

Prompt shape, same three routes:

| Route | No-tool answer | 30k-char answer | Difference |
| --- | ---: | ---: | ---: |
| GPT-6 · Light | 14.9 (12.9–16.2) | 16.9 (10.5–16.9) | +2.0 |
| Sol · Medium | 15.3 (15.1–20.7) | 14.1 (12.9–14.9) | −1.2 |
| GPT-6 · High | 14.9 (13.3–16.7) | 15.0 (14.5–30.7) | +0.1 |

Setup medians were 3.9s fresh and 1.1s retained. Within fresh setup, temporary-chat
preparation took 1.6s, effort selection 0.85s, prompt attachment 0.42s and send
0.85s. Native tool execution took 0.04s. **Accepted-prompt → first tool call** was
20.6s median for fresh reads and 7.7s for retained reads.

No turn emitted an `agent_thought_chunk` before its tool card (0 of 54 serial
turns), and no first answer chunk preceded the first tool call. The user-visible
turn therefore stays silent for the whole 10–34 second post-submission window.

## Concurrency: the bottleneck moved local

The concurrency arm did **not** speed up the matrix, and the reason is local
memory rather than upstream ChatGPT.

Before the four batches, admission capacity had fallen to **1, 1, 1 and 2** (ceiling
32). The browser process tree held **17.1–17.5 GiB** of retained pages, leaving
10.1–10.9 GiB available; the learned per-turn cost was 3.3–4.8 GiB. Capacity is
derived from that budget, so simultaneous turns mostly queued.

| Width | Batches | Turns completed | Median turn | Batch wall | Queue wait, total | Throughput |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 2 | 3, 3 | 56.9s, 58.1s | 86.8s, 90.9s | 87.2s, 91.6s | ~2.0/min |
| 6 | 2 | 5, 6 | 77.1s, 77.8s | 160.5s, 109.2s | 389.7s, 287.3s | 1.9–3.3/min |

A single serial fresh read runs at about 2.2 turns/minute. Concurrency therefore
bought no throughput while it tripled per-turn median latency through queueing.
The queue waits account for the inflation almost exactly: with capacity one, a
three-turn batch admits one turn immediately and makes the other two wait.

This is not evidence that the service cannot run concurrent turns; the earlier
12-client check reached eleven simultaneous turns on a cooler process tree. It is
evidence that **retained pages consume the same budget that concurrency needs**.
`MAX_CHATGPT_BROWSER_TABS` defaults to 32 and nothing retires idle pages by age.
After 54 isolated sessions the pool held dozens of pages.

The one failure was in the six-way batch: the model answered "Unable to complete:
the direct DSH `read` tool is not exposed in this session" instead of calling the
available tool. It was a model/tool-routing failure, not a transport or admission
error; the other five turns in that batch and all other batches passed.

## Where the time goes

1. **After submission.** Fresh reads spent 23–34s after `send-accepted`; no-tool
   answers spent 10–11s. Setup, MCP startup (0.28s), tool execution (0.04s) and
   admission (zero wait in the serial arm) are small.
2. **Fresh versus retained.** Starting a new ChatGPT conversation costs a 1.6s
   temporary-chat step plus a much larger model-side penalty: retained turns
   reach the first tool call in 7.7s versus 20.6s fresh.
3. **Tool calls on fresh conversations.** A no-tool answer takes ~15s; a fresh
   read takes 27–38s. On a retained page the same read costs ~15s. The tool round
   trip itself is milliseconds, so the extra 12–23s is model planning/routing
   around the first tool call.
4. **Payload is not the main lever.** 30,000 extra characters moved the median by
   about a second. The larger payload analysis (below) is still important for
   context limits, but it does not explain a 20-second wait.
5. **No progress signal.** Nothing is emitted between prompt submission and the
   tool card, so all of the above is invisible in T3.

## Solutions and improvements

Ranked by user-perceived effect per unit of risk.

### 1. Emit one truthful progress update from `dsh-acp` (highest effect)

ACP owns `session/update`; this plugin cannot reach it. The installed
`@deepseek-ai/dsh-acp` deliberately carries only committed semantic updates and
ignores the live `agent/assistant-stream` channel that `dsh-headless` already
consumes. A small core patch can listen for the stream `start` frame and emit one
`agent_thought_chunk` such as “Waiting for chatgpt-web/gpt-6-light…”, using the
agent's actual provider/model.

- Effect: converts 10–34s of silence into a visible, honest milestone. It does not
  reduce execution time.
- Effort: ~0.5 day, following the existing `scripts/patch-dsh-acp-tool-presentation.mjs`
  anchor/backup/apply pattern.
- Risk: it is a `node_modules` patch that must be reapplied after DSH upgrades.
  Wording must say “waiting for model”, not imply the model is already thinking.
  Deduplicate per turn/step and chain through `outputTail` so it cannot overtake
  the tool card.
- Do not synthesize a thought inside the model stream: that would pollute
  conversation history and be replayed as reasoning.

### 2. Bound retained browser pages and retire idle ones

The concurrency result is an operational warning: parallel agents queue when the
retained-page pool eats the memory budget. Options:

- Set `DSH_CHATGPT_WEB_MAX_TURNS` to roughly 8 on this 32 GiB host. It is the
  shared ceiling for admission, workers and retained pages, so it caps the pool.
- Add an idle TTL or capacity-aware trim to `ManagedConversationPool` (close the
  least-recently-used idle page when capacity is below demand).
- Until then, size concurrent work from `/healthz` `browser_admission.capacity`,
  not from the 32-tab ceiling.

Expected effect: keeps capacity above one, so parallel agents actually overlap
instead of serializing behind a 30s queue. Risk: a closed page forces a fresh
conversation next time (+9–23s on that turn).

### 3. Keep conversations retained wherever possible

Retention is already implemented and verified, and it is the single largest
measured saving. Make sure T3 threads continue the same managed conversation
rather than creating a new one, and avoid unnecessary fresh sessions. A fresh
conversation pays both the 1.6s preparation step and the 13s-larger model wait.

### 4. Use Light for latency-sensitive turns

Fresh read medians were 26.9s (Sol Light) and 27.1s (GPT-6 Light) versus 31.5–38.2s
for the other four routes. On retained turns the spread collapses to ~1s. With
three samples these are descriptive, not a guaranteed ranking, but Light is the
safer default when the first response time matters.

### 5. Treat payload trimming as a context-limit fix, not a latency fix

A separate static analysis found that 79% of a real 84,183-character T3 prompt is
the inlined tool inventory (66,754 characters; the T3 app's own MCP server is
~56%). The matrix shows 30k extra context characters cost ~1s, so inventory
trimming is unlikely to recover the 20s wait by itself. Still worth doing for the
observed “messages too long” failures and for retained-turn re-sends:

- Send the inventory only when the conversation is fresh or its hash changes.
- Compact the inventory to name + one-line description + compact signature
  (measured ~57% smaller), keeping exact schemas behind search.
- Do not remove tools without preserving discovery and capability.

### 6. Bound parallelism to real capacity

For agent fan-out, read `browser_admission.capacity` and queue only what fits.
Six-way fan-out on a capacity-one service is slower than serial work. With a
properly trimmed page pool, the earlier 12-client evidence suggests several
simultaneous turns are viable.

## Reproduce

```sh
python3 scripts/measure-latency-matrix.py --runs 3
python3 scripts/render-latency-report.py \
  --summary docs/model-latency-matrix-2026-11-08.json \
  --html docs/model-latency-matrix-2026-11-08.html
```

The driver refuses to reuse a non-empty output directory, records `/healthz`
before and after each stage, tolerates a stable external-turn baseline, and never
restarts the service or changes admission policy.

## Limits

- Three samples per cell support medians and ranges, not p95 or stable rankings.
  Model order was alternated, and no run-to-run drift was observed.
- The concurrency arm is a memory-pressure result, not a clean concurrency-ceiling
  test. Capacity was 1–2 because of retained pages.
- One six-way turn failed with the model claiming `read` was unavailable.
- The 30k-character prompt is smaller than a real 84k T3 payload; it tests
  marginal context cost, not the full production payload.
- Browser `send-accepted` is DOM evidence of submission, not packet-level server
  receipt. Upstream queueing and connector routing remain unobservable.
