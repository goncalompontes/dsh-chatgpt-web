# Long native tool calls through external MCP

The failed 180-second workload in `measured-turn-concurrency-2026-11-08.md`
had a concrete local deadline: the gateway log records
`[chatgpt-web-mcp] bash did not complete within 90000ms; retired its turn binding`
and the same error for `job_output`. This retired the broker capability while
native execution was still running. Later results could not resume that retired
turn. Increasing hardware concurrency cannot fix this transport policy.

That ninety-second limit was introduced to settle before the legacy OpenAI
tunnel's two-minute response deadline. External DSH calls now use a distinct,
bounded ten-minute invocation budget. The provider stamps the transport type on
the trusted broker environment at registration and continuation; model arguments
cannot select this policy. Manual/legacy tunnel requests keep their existing
ninety-second limit. A turn's earlier expiry always wins, and abort signals still
cancel requests immediately.

The external fallback prompt now requests `timeout_s:660` from the gateway,
giving the inner ten-minute deadline time to settle before the outer request
expires. Direct DSH aliases already use the gateway's configured maximum.
This does not override lower caller or administrator-configured limits.

For commands expected to run for minutes, transport guidance prefers native
background/job tools and bounded output polls when available. It explicitly
requires checking the existing job/task before retrying after a transport error:
a timeout does not establish that a command stopped. The bridge does not replay
commands or convert them silently into new jobs.

The load smoke now requires exactly one completed foreground tool, its actual
output marker, the final answer marker, and elapsed time at least as long as the
requested delay. Its prompt requires a sufficient native execution timeout and
forbids background execution. `background-long` supplies a separate long-job
scenario with a concurrent README read and collected native job output.

Validation: **145 tests passed, 0 failed, 1,070 assertions across 27 files**;
typecheck, build, Python parsing, whitespace and clean-tarball checks passed.
The policy test verifies the external budget, unchanged legacy budget and earlier
turn expiry. The external routing regression checks the fallback gateway budget.

The supervisor had already stopped idle workers with no clients before deployment.
`stack.py ensure` started sidecar PID 2628245 and gateway PID 2628246; router PID
1359 was unchanged. CLI SHA-256:
`9004049a35c202875c3c6b1bc772b2df8d91075f01d648ce874b4cfbbddbb528`.
After the reminder fix, an idle drain/shutdown restarted the sidecar as PID
2663013; gateway and router stayed healthy. The external MCP registry launches a
fresh stdio process per call, so it picks up the rebuilt bundle without a gateway
restart. That deployed bundle SHA-256:
`3f91834fa06d71eb75c1c45ae9a8086545e3f1bb2043c586db6eea21be830686`.


## Harness and provider research

Official documentation inspected on 2026-11-08:

- [Claude Code background bash](https://code.claude.com/docs/en/interactive-mode#background-bash-commands)
  returns task IDs and retains output in files. Its foreground timeout can move a
  command to the background, with documented exceptions (including commands
  starting with `sleep`, disabled background tasks, and bare mode).
- [Gemini CLI shell](https://geminicli.com/docs/tools/shell/) supports
  `is_background` and returns background process IDs.
- [OpenAI shell](https://developers.openai.com/api/docs/guides/tools-shell)
  exposes an execution `timeout_ms`; local runtimes return explicit timeout
  outcomes and partial output. This alone does not make arbitrary tools durable.
- [OpenAI Responses background](https://developers.openai.com/api/docs/guides/background)
  supports asynchronous response generation with polling and cancellation. That
  lifecycle applies to the model response, not automatically to local commands.
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
  recommends configurable request deadlines and cancellation. Progress may reset
  an idle deadline, while an absolute maximum should still apply.
- [MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
  separates execution from request lifetime using durable task IDs, polling,
  result retrieval and explicit cancellation. Tasks are experimental and require
  capability/tool negotiation; ChatGPT connector support has not been established.

The shared pattern is to start once, retain a job/session ID, poll within bounded
requests, collect retained output, and cancel explicitly. Increasing a transport
budget alone does not implement durable jobs. The current bridge uses DSH's
existing background/job tools rather than assuming unnegotiated MCP Tasks.

## Long-job continuation regression

The first 180-second background test timed out at its 480-second caller limit.
Native session evidence shows the process finished successfully, but after the
third identical `job_output` poll, DSH injected its repeat-tool reminder. The
bridge treated this user-shaped producer notice as a human revision, changed
browser execution keys, and waited for ownership retirement while the original
browser still awaited its tool result. DSH's model-stream idle timeout eventually
retried the same stalled continuation.

The bridge now recognizes both pinned reminder formats. The gentle reminder
requires three distinct, completed preceding calls with identical names and
canonical arguments. The detailed reminder also requires its claimed tool, count
and full canonical arguments to match the completed call history. The first
patched live run passed the third poll but exposed the detailed format at poll
five; that run was explicitly cancelled after diagnosis. It remains context,
not a new human revision or filesystem authority. Regression coverage also checks
unproven reminders, altered human messages, unrelated calls and duplicate IDs.
The long-job smoke additionally checks the actual collected output, one command
execution, bounded polling and minimum elapsed job duration.


## Foreground and cancellation live validation

Two concurrent native foreground `bash` calls each ran `sleep 180` and returned
their actual output and final markers. Both completed successfully (total ACP
elapsed times 231.72 and 212.97 seconds); neither was replayed. Evidence:
`/tmp/dsh-admission-load-dmfkry34/`, `/tmp/dsh-long-tools-live.log`.
Cancellation during a long command settled its tool as failed, then a replacement
command completed; the concurrent long calls were unaffected. Evidence:
`/tmp/dsh-long-tools-cancel-live.log`.


## Final runtime validation

The unrelated ACP turn finished naturally. With zero active HTTP/browser turns
and no pending admission requests, authenticated drain/shutdown reloaded the
sidecar as PID 2691136. Gateway PID 2628246 and router PID 1359 remain healthy.

The final 180-second background run passed: exactly one background bash,
a concurrent README read, five job-output calls with 30-second budgets, actual
`DSH_BACKGROUND_OK` collected in completed native tool output, and the final
answer marker. Native history confirms both `job_output × 3` and
`job_output × 5` reminders were delivered without changing execution ownership.
Evidence: `/tmp/dsh-long-background-final.log`,
`/tmp/dsh-acp-updates-cicko4bc.jsonl`, native session
`9fc086f1-30ee-4f0c-a1d4-8d0e8bf1a347`. The smoke process exited 0 and closed
its session. Final health showed zero active HTTP/browser turns and no queued
admissions. All timeout changes and both reminder fixes are now deployed.

Final built CLI SHA-256: `fe5eba2d46ee0460eeb9673e9ad68a9054e3329fd7311c1143dad9a44204b023`.
