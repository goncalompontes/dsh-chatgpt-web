# Desktop tool discovery failure

The desktop DSH session started at 10:52:39 UTC with `chatgpt-web/gpt-6-high` and 32 native tools, including `bash`, `read`, `glob`, and `grep`. Its browser execution was `5b77856e4698`. The request completed with a blocker report at 10:54:43; it never emitted a native DSH tool call.

Gateway audit evidence shows two searches with long, multi-word queries returning zero results. Dynamic MCP search requires **all** query terms to match one tool descriptor. These responses did not establish that the tools were missing. The agent then inspected `dsh:codex_tool_inventory`, which the configured DSH-only gateway explicitly rejects. The transport prompt incorrectly recommended that blocked wrapper as its discovery fallback.

The final answer also reported unknown legacy local-shell tools and an invalid turn token. Unknown tool requests can fail before entering the audited tool function, so absence from the audit alone cannot establish whether they occurred. However, the sidecar contains no broker claim for this turn's token hash (`e38fd579f047`) and no matching invalid-token event. Token expiry is therefore unverified. The gateway continued completing DSH calls for the separate TUI session during the same period.

The transport now includes the current request's native tool names, descriptions, and schemas. This distinguishes the active profile from the gateway's superset of optional tools. Recovery uses `mcp_tool_search` with `query: "dsh"`, `server: "dsh"`, and `limit: 100`, followed by `mcp_tool_call` with `name: "dsh:<wire_name>"`, the current token and native arguments nested inside `arguments`, and `timeout_s: 120`. It does not require restoring local-shell file tools or exposing blocked Codex wrappers.

Regression tests cover the current native schema, exact discovery query, supported recovery path, and exclusion from compaction prompts. These changes take effect after the sidecar next loads the rebuilt bundle; rebuilding alone does not change an already running sidecar. A user can use the same supported discovery instructions in a follow-up prompt immediately without restarting an active session.
