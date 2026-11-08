# ChatGPT Web startup latency — 2026-11-08

> Follow-up: the [latency matrix](model-latency-matrix-2026-11-08.md) repeats the
> measurement with three runs, three prompt shapes and a concurrency arm (71 turns).

The dominant measured interval is **after ChatGPT accepts the prompt and before
its native tool request arrives**. Browser preparation explains a smaller part of
the first-message delay. The run also exposed a visibility gap: none of the 24
turns produced an ACP thought/progress message before its first tool card.

## Available routes and results

The live `/v1/models` catalog advertised GPT-5.6 Sol and GPT-6, each at Light,
Medium and High. Luna is unavailable while this account exposes the Sol selector;
Extra High and Pro are disabled by the account capability configuration. No model
or account settings were changed to manufacture additional availability.

Numbers below measure **ACP message submission → first native tool call**, not
completion of the whole answer. Each cell contains the mean and observed range
of two samples. First-message native-host setup adds another 0.89–1.03 seconds
before the ACP prompt is sent.

| Model | Fresh mean (range) | Follow-up mean (range) | Fresh setup mean | Fresh post-submit mean |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol · Light | 22.4s (19.7–25.0) | 9.5s (7.9–11.2) | 4.5s | 17.9s |
| GPT-5.6 Sol · Medium | 24.1s (14.8–33.4) | 7.9s (7.4–8.4) | 4.0s | 20.1s |
| GPT-5.6 Sol · High | 25.9s (24.1–27.7) | 14.1s (12.6–15.6) | 3.8s | 22.1s |
| GPT-6 · Light | 17.1s (14.3–20.0) | 9.9s (8.0–11.9) | 3.8s | 13.3s |
| GPT-6 · Medium | 25.3s (21.6–29.0) | 8.4s (8.2–8.6) | 6.6s | 18.6s |
| GPT-6 · High | 29.1s (25.2–33.0) | 9.4s (9.3–9.6) | 4.0s | 25.1s |

[Chart](model-startup-latency-2026-11-08.html) ·
[Individual measurements](model-startup-latency-2026-11-08.json)

Fresh means a new native session and new ChatGPT conversation. Follow-up means
the same native session and a confirmed retained ChatGPT page. The services were
already running: this is not a machine-boot or idle-service cold-start benchmark.

## Method

- Discovered all six routes from the running service, then ran two serial sweeps,
  reversing model order in sweep two to reduce fixed-order bias.
- Created 12 isolated native ACP sessions, with a fresh and retained turn in each:
  24 successful turns, zero failures, exactly one completed native `read` per turn.
- Used the same prompt each time: read README.md lines 1–5, then return a fixed
  marker. The native runtime really executed the tool. No T3 threads were created.
- Timed ACP process/session/model setup, each received ACP update, native tool
  completion and final response. Monotonic time measures total duration; wall
  timestamps correlate ACP events with browser diagnostic `capturedAt` values.
- Matched each turn to exactly one browser trace, saved its stage logs and
  diagnostic checkpoints, and verified fresh/retained page selection.
- Browser setup ends at the observed `send-accepted` checkpoint. This is browser
  evidence of submission, not a packet-level server-receipt timestamp. The next
  interval ends when ACP exposes the first native tool request.
- Ran three independent local MCP process initialization + `tools/list` probes.
  This isolates local server startup; it does not measure the entire remote
  ChatGPT-to-gateway network round trip.

Raw private evidence: `/tmp/dsh-model-latency-s5g268md/`; sweep log:
`/tmp/dsh-model-latency-run.log`. Aggregated JSON excludes private raw prompt/log
content. Browser diagnostics rotate; current probes copy checkpoint times into
JSONL before rotation. The earliest probe checkpoint times are also retained in
`checkpoint-archive.json`, including submission times saved in live sweep output.

## What accounts for the delay

1. **Most measured time is beyond local preparation.** Fresh setup took
   3.65–9.62 seconds. Average post-submission time before the native request ranged
   from 13.3 to 25.1 seconds across routes. This bucket combines upstream model
   processing/planning, any upstream queueing and connector routing. These
   measurements cannot separate those causes inside ChatGPT.
2. **A fresh browser conversation costs extra time.** Temporary-chat preparation
   normally took roughly 1.5–2 seconds, with one 7.73-second outlier. Model/effort
   selection took 0.54–1.08 seconds, prompt attachment 0.20–0.55 seconds and the
   observed send stage 0.66–0.92 seconds. Retained setup took just 1.04–1.30 seconds.
   Existing 100ms confirmation polling and 250ms UI settling are accounted for in
   these stages; they do not by themselves explain a 20–90-second silent wait.
3. **Local startup and tool execution are small here.** Native-host setup was
   0.89–1.03 seconds. Local MCP initialization plus discovery of 55 tools took
   0.274–0.283 seconds in the three original probes. Native read completion took
   14–135ms, including ACP delivery overhead. A repeat MCP-only probe produced
   0.277–0.286 seconds. Increasing long-tool deadlines would not accelerate this
   pre-tool interval.
4. **The serial run did not queue behind admission.** The global queue-wait counter
   stayed at its preexisting 18,698.036915ms value, so this benchmark added zero
   queue wait. No requests were rejected. Final health was idle with no pending
   admissions, about 17.3GB available memory and one-minute host load 1.37 on
   32 logical CPUs. This does not test latency under many concurrent agents.
5. **The actual T3 workload can be larger.** The controlled ACP fresh prompts were
   about 30,300 characters. The earlier transit request compiled to 84,183 characters with
   T3 context/tool definitions. Its native journal shows 93.088 seconds from
   native turn start to first `web_fetch`, and about 94.786 seconds from T3's
   server-side message request to that native tool call. Its broad research task
   may also have included ChatGPT-native search/planning before the DSH call.
   Payload size is a plausible additional contributor, not an isolated causal
   result of this benchmark. User-device/network delay was not measured.
6. **Visible inactivity is a separate problem.** Zero of 24 controlled turns sent
   an `agent_thought_chunk` before the tool card. A future progress improvement
   should report real milestones such as preparing the browser and waiting after
   submission, rather than implying native tool work has already started. Such
   feedback improves visibility without claiming to reduce execution latency.

## Practical implications and limits

Retaining the correct conversation already saves browser setup time and was
verified in every follow-up. GPT-6 Light had the lowest fresh-chat mean (17.1s)
in this run. However, sample variation was substantial—for example, Sol Medium
fresh calls took 33.4s and 14.8s. Two samples per case do not establish stable
rankings, p95 latency, or a general High-versus-Medium performance rule.

The next useful experiments are a controlled full-T3-inventory versus reduced-
inventory comparison and explicit measurement of real browser progress visibility.
These would test payload/routing cost separately from model variability. Do not
change the user's chosen reasoning effort or advertise a smaller inventory as
available without preserving actual tool discovery and capabilities.

## Reproduce

Run while other native sessions have no active or queued turns. The measurement
script refuses to start another model case while the service reports active work.
It never restarts services or changes admission policy.

```sh
python3 scripts/measure-model-latency.py --rounds 2
python3 scripts/measure-model-latency.py --summarize /tmp/dsh-model-latency-<run>
python3 scripts/measure-model-latency.py --mcp-startup-only /tmp/dsh-mcp-startup
```

Verification: Python syntax parsing, timing-order checks for all 24 rows, distinct
session counts, exact fresh/retained selection, the live 24-turn sweep and the
standalone MCP-only command all passed. No production runtime code changed;
sidecar PID 2729943, gateway PID 2628246 and router PID 1359 remain running.
