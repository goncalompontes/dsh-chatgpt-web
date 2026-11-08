# Useful DSH integration features

Source review, 2026-11-06. Recommendations, not implemented features. The review covers this repository and interfaces in the installed DSH 0.2.2-rc.1 and dsh-tui 0.19.0 packages. Relative effort estimates describe scope, not delivery promises.

The largest opportunity is to make ChatGPT participate in DSH's session experience: know the current project, use its jobs and questions, deliver real files, and preserve task state. The external MCP connector can remain the tool transport throughout.

## What already exists

- Text and visible reasoning summaries stream back to DSH; DSH tools execute through their normal runtime and UI lifecycle.
- Input images are uploaded to ChatGPT, including images in supported tool results. The browser message limit is ten images; this is not a new vision feature to build.
- Tool inventory already supports search, pagination, and exact schemas. A second generic tool catalog would duplicate it.
- Conversations can be retained and resumed; compaction and Luna checkpoints exist. Session continuity needs DSH-specific coordination rather than another independent memory store.
- Browser concurrency is already bounded at five active turns. Scheduling and ownership visibility are the missing product experience, rather than basic multiple-tab support.
- The Web settings page already exposes sidecar status, transport tuning, and recent turns. It does not supply the same experience inside the TUI.

Evidence: [prompt compilation](../src/adapters/chatgpt-web/prompt.ts), [tool inventory](../src/adapters/chatgpt-web/mcp-server.ts), [conversation reuse](../src/adapters/chatgpt-web/conversation-key.ts), [concurrency](../src/adapters/chatgpt-web/concurrency.ts), [Web settings](../client.js).

## 1. Sessions that follow the actual DSH workspace

**User benefit:** Open two DSH chats in different repositories, change a session's working directory, or resume a chat tomorrow; ChatGPT gets the right project, instructions, and available tools automatically.

Currently the Cordis plugin mostly starts the sidecar. The external MCP configuration supplies a global workspace/policy fallback, while metadata-free turn identity is inferred from a cache key and human-message content. DSH already owns durable session identity, turn numbers, working-directory changes, policy, and message provenance.

Add a versioned DSH session context containing session ID, turn identity, request purpose, cwd, resolved policy, and a revision of the active tools. Bind it to the current request rather than editing model history. Resolve environment facts from DSH services, not by interpreting arbitrary user text. This also enables a useful “Current project” view in plugin status.

Preserve source identity for context delivered to the model: distinguish a human instruction from workspace instructions, a skill catalog, a job notice, a checkpoint, and a message from another agent. DSH has structured `MessageSource` and `ContextForm`; the generic pi-ai conversion reduces many of these to user-role text. A source-aware bridge can explain, for example, that a new job notice updates task state without treating it as a new human request.

**Implementation:** Start with the provider-scoped `llm-pi-ai/request-headers` hook, which exposes session ID, purpose, and endpoint. A local session-context registry can supply request metadata without changing pi-ai. Full provenance needs a separate manifest captured from the immutable `llm/stream` request, or a native DSH adapter; headers alone do not expose message sources or turn numbers. Do not use the deprecated `agent/request` waterfall for new work. Preserve DSH's logged model-visible content.

**Scope:** Medium; foundation for most items below. Acceptance: two concurrent projects, cwd change, repeated prompt, fork, and resume each retain the correct session context.

Evidence: [plugin lifecycle](../src/plugin.ts), [fallback identity](../src/adapters/chatgpt-web/environment.ts), [thread environment](../src/adapters/chatgpt-web/thread-environment.ts), [external MCP config](../src/types.ts). Installed DSH interfaces: `dsh-llm-pi-ai/lib/types/index.d.ts`, `dsh-llm/lib/types/message.d.ts`, `dsh-working-directory/lib/types/index.d.ts`, `dsh-sandbox-policy/lib/types/index.d.ts`.

## 2. Setup, model selection, and controls inside DSH

**User benefit:** Install the plugin, connect the account/connector, and select an available model in DSH without copying provider YAML, a control token, and browser transport settings between applications.

Provide a DSH command/settings entry for connection status, account verification, available models and efforts, active project, and a two-call connection check. Offer explicit actions to open login, refresh models, and test the connector. The TUI and headless command should share the same backend as Web settings.

Populate DSH's model selector with the plugin's existing account-filtered routes and correct transport budgets. Refresh that catalog after an explicit account-capability refresh. The current DSH `/v1/models` returns IDs only; the README still asks users to configure pi-ai models manually.

**Implementation:** First generate or adopt provider settings through supported DSH configuration services. A native `LlmAdapter` is a later option for owning model metadata directly, not a prerequisite for every feature. Keep secrets in host storage; the DSH client should not require manually copying the sidecar control token. Background status probes should be read-only; the live connection test should be an explicit action.

**Scope:** Small to medium for the command and setup flow; larger for a native adapter. Acceptance: a fresh profile reaches a working model selector and an actionable status screen using the plugin's guided setup.

Evidence: [manual provider setup](../README.md), [DSH setup](../src/setup.ts), [model endpoint](../src/server.ts), [model routes](../src/chatgpt-web-models.ts), [existing settings](../client.js). DSH exposes `ctx.llm.registerAdapter`, model metadata, and model-update notifications.

## 3. Long-running work with live DSH progress

**User benefit:** Ask for a large test suite or build, watch its output, continue independent work, and receive completion in the chat. A long command becomes a visible task the user can stop.

DSH already supports `bash` background execution, `job_output`, `job_list`, `job_kill`, live output, and completion notices. The current connector prompt gives only generic advice to use an asynchronous tool for work longer than 90 seconds. Make these DSH capabilities an explicit, schema-driven workflow.

Add session-scoped bridge activity such as “Connecting to ChatGPT”, “Waiting for connector confirmation”, “Running tests”, “Waiting for your answer”, and “Queued for a browser slot”. Show elapsed time and the actual job label. Use observed states rather than invented percentages or hidden reasoning.

**Implementation:** Detect the current inventory's background-job parameters and tools. Request short foreground waits or background execution through normal DSH tools. Feed committed completion notices into the next DSH step and browser continuation; where a browser generation is still running, apply the notice at a supported boundary. Stream UI progress through a dedicated DSH event/projection. Existing MCP activity tracking is internal liveness information; adding custom SSE events alone will not make pi-ai or the TUI render it. The installed working-activity plugin is an integration point, not an API to overwrite blindly.

**Scope:** Medium. Acceptance: a three-minute test job returns a handle promptly, streams in DSH, can be stopped, and delivers its final result once. DSH's shipped jobs are process-local; this does not promise survival across a laptop reboot.

Evidence: [current asynchronous guidance](../src/adapters/chatgpt-web/prompt.ts), [internal progress tracking](../src/adapters/chatgpt-web/turn-progress.ts), [90-second MCP deadline](../src/adapters/chatgpt-web/mcp-server.ts). Installed packages: `dsh-tool-bash/README.md`, `dsh-jobs/README.md`, `dsh-tool-jobs`, and `dsh-working-activity/src/events.ts`.

## 4. Questions, decisions, and steering in the DSH conversation

**User benefit:** ChatGPT presents a multiple-choice decision in DSH, continues unrelated work while the user considers it, and incorporates the answer when it arrives. The user can send a correction or stop the active work from the same session.

The generic inventory can already expose `ask_user_question`; discoverability is not the missing feature. Add a DSH-aware interaction contract for pending answers, delayed user messages, and steering. Keep actual execution approval in DSH. ChatGPT's connector “Allow once” is a separate transport decision and is not permission for a filesystem action.

**Implementation:** When the timed question schema is available, use a foreground timeout comfortably below the MCP deadline and honor its pending call ID. DSH's documented timed default is 120 seconds, so it cannot simply be passed through a 90-second MCP call unchanged. A later answer must retain its original question/call association in the next model step. Blocking questions and long-lived execution approvals need a proper pending-result/resume design if they can outlive the gateway; do not pretend a timeout is an answer. Route stop and steering through the live DSH agent/inbox and signal, rather than appending text into a shared browser page.

**Scope:** Medium to large. Acceptance: the user answers after two minutes, the question remains answerable, the agent resumes once, and cancellation prevents later unintended work.

Evidence: [inventory relay](../src/adapters/chatgpt-web/mcp-server.ts), [message envelope](../src/adapters/chatgpt-web/prompt.ts). DSH interfaces: `dsh-tool-ask-user/README.md`, `dsh-user-questions`, `dsh-user-approval`, and `dsh-agent/lib/types/runtime-types.d.ts`.

## 5. Real files and visual results in both directions

**User benefit:** Attach a document for analysis and receive a generated chart, image, spreadsheet, or report as a file that opens from DSH and remains usable after ChatGPT's temporary page closes.

There are two distinct increments:

1. Improve local deliverables now: teach the model to use the current DSH `present` tool when it exists, and preserve full paths and file identity in results. Files made by DSH tools can already use this path.
2. Add an explicit artifact importer/exporter for ChatGPT-native attachments. Save generated bytes into DSH-managed storage, record their session association and source, and render local links/previews. Ordinary Markdown links already survive conversion; native image and widget output does not. The Markdown converter explicitly removes images, SVG, canvas, and several rich cards.

For input, DSH deliberately projects non-image files into read-only path handles before provider dispatch. Native PDF/document upload therefore requires a supported attachment-service path or an explicit export tool, not merely adding `input_file` parsing to the sidecar. Retain on-demand DSH reads as the default for source-code files; uploading whole repositories would add cost and stale copies. Imported citations/source lists can accompany research artifacts where browser evidence exposes real URLs.

**Implementation:** Reuse DSH attachments, filesystem access, and `present`. Transfer only explicit attachment/artifact references, with filename, MIME type, size, and local destination. Use actual browser download events or authenticated artifact links; do not turn every webpage image into a deliverable. Host-side file capture and TUI/Web preview support need separate verification.

**Scope:** Small for DSH-created deliverables; large for native browser file exchange. Acceptance: a generated chart is saved and linked locally, and a selected document reaches ChatGPT with a confirmed attachment name.

Evidence: [text/image content vocabulary](../src/types.ts), [input uploads](../src/adapters/chatgpt-web/browser-worker.ts), [rich-output filtering](../src/adapters/chatgpt-web/markdown.ts). DSH references: `dsh-llm/lib/types/content.d.ts`, `dsh-attachment`, `dsh-tool-present/README.md`.

## 6. A visible long-session handoff

**User benefit:** Resume after a restart, switch models, or fork an experiment while retaining decisions, changed files, unfinished tasks, test evidence, and open job references. See when older conversation has been summarized and what the summary preserved.

Build on DSH's session log and `/compact`, with an optional structured task-state view: objective, constraints, decisions, current files, last checks, open work. The same checkpoint should drive browser rehydration when reuse is unavailable. DSH remains the durable record; a Temporary Chat tab is an optimization.

Expose estimated context pressure with separate model-context and browser-message budgets. Current adapter usage is explicitly estimated, not an authoritative provider usage or account quota. Coordinate DSH compaction with browser conversation epochs so both sides agree on the retained task state. Let users inspect the handoff and deliberately start a fresh browser conversation without discarding the DSH session.

**Implementation:** Connect DSH's checkpoint provenance, token meter, and compaction events to the existing conversation key and checkpoint machinery. Do not run a second unrelated summarizer on every turn. Preserve tool-call/result pairs and current work through transitions.

**Scope:** Medium to large. Acceptance: compact a long session, restart the sidecar, resume on a different effort, and correctly identify the last passing tests and remaining task without replaying obsolete tool operations.

Evidence: [retained conversation epochs](../src/adapters/chatgpt-web/conversation-key.ts), [Luna checkpoints](../src/adapters/chatgpt-web/rolling-checkpoint.ts), [usage estimates](../src/adapters/chatgpt-web/usage.ts), [browser input budgets](../src/adapters/chatgpt-web/input-tokens.ts). DSH: `dsh-compaction/README.md`, `dsh-compaction/lib/types/checkpoint.d.ts`, `dsh-token-meter`.

## 7. Tool results that retain useful execution facts

**User benefit:** The model can distinguish a failing test from a transport failure, see the directory and exit code of a command, follow a background job, and retrieve a large output file without guessing from a truncated transcript. Users retain DSH's existing tool cards and diffs.

Currently text/image results cross the Responses boundary, then the broker attempts to recover `structuredContent` by parsing JSON text. This preserves tools that already render JSON, but cannot reliably recover arbitrary canonical DSH values or presentation metadata from a text rendering. Do not claim all structured results are lost.

Add an optional typed result envelope for known facts: outcome, cwd, exit code, duration, job ID, output truncation/spill reference, and artifact references. Expose inventory capabilities such as background execution and question support as explicit, current facts. Preserve unknown tools without inventing semantics or rewriting their schemas.

**Implementation:** Correlate the final read-only `tools/result` notification with the call ID and session, then attach supported canonical facts to the matching broker result. Ensure the exact final approved result reaches the model; observers must not execute tools twice or expose pre-policy values. Keep large output in DSH's existing spill service and let the model fetch selected ranges. Local result presentation remains owned by DSH.

**Scope:** Medium; benefits from item 1. Acceptance: a failed command, a pending job, an image result, and a truncated output each round-trip with the correct identity and usable facts.

Evidence: [broker result conversion](../src/adapters/chatgpt-web/index.ts), [tool result type](../src/types.ts), [inventory](../src/adapters/chatgpt-web/mcp-server.ts). DSH: `dsh-tools/lib/types/events.d.ts`, `dsh-tools/lib/types/schema.d.ts`, `dsh-tool-bash/README.md`.

## 8. Coordinated sessions and subagents

**User benefit:** Run several chats or delegate a review, see which agent is working or queued, and cancel one without affecting the others. A parent can consume a child's result and deliver its files through normal DSH ownership.

The plugin already has up to five browser slots and Codex-oriented lineage support. Extend those with native DSH parent/child session ownership, a bounded admission queue, and explicit queued/active states. A dedicated adapter or metadata bridge should distinguish auxiliary calls, such as title generation and compaction, from user task turns; DSH already supplies request purpose.

**Implementation:** Keep each active browser generation isolated. Apply fair admission and cancellation before acquiring a slot. Queueing requires a compatible deadline/heartbeat strategy so callers do not simply time out while waiting. Preserve child tool scope and return summaries/artifact references through DSH's subagent system, rather than creating a second delegation runtime inside the MCP server.

**Scope:** Large; follows native session identity and activity reporting. Acceptance: two projects and a child review run concurrently, excess work queues visibly, and cancelling one queued or active task leaves the others intact.

Evidence: [five-tab limit](../src/adapters/chatgpt-web/concurrency.ts), [session admission](../src/adapters/chatgpt-web/turn-execution.ts), [lineage handling](../src/adapters/chatgpt-web/environment.ts). DSH: `dsh-tool-subagent`, `dsh-llm/lib/types/types.d.ts` (`purpose`, `sessionId`).

## Suggested delivery order

1. **DSH context and controls:** Native session/workspace metadata, a shared status/setup command, and model discovery. Establish the integration contract and remove routine configuration work for users.
2. **Interactive work:** Background-job guidance and completion delivery, visible bridge activity, and timed DSH questions. These make longer tasks practical in the existing connector mode.
3. **Deliverables and continuity:** DSH `present` guidance, typed execution facts, visible checkpoints/context budgets, then native ChatGPT artifact import.
4. **Broader concurrency:** Native child-session mapping and queueing after ownership and interaction semantics are explicit.

Keep the current external MCP route while developing these. A native DSH adapter is valuable if full provenance, file exchange, and model metadata justify it, but replacing the connector or removing turn capabilities is not necessary to deliver the first increments. The capability token still binds browser-originated calls to an exact active DSH turn; native session IDs describe ownership and are not a replacement for that binding.

This review changed documentation only. No speculative features, service restarts, or runtime configuration changes were made.
