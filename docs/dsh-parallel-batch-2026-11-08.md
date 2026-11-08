# Native DSH batch dispatch follow-up

The live model-driven overlap smoke continued to emit independent calls serially.
The native DSH scheduler explains why that is not a provider-wide concurrency
failure: the tool contract requires `isConcurrencySafe(args) === true` for overlap;
omission, exceptions, and non-true values are exclusive. Installed DSH file tools
opt into this classifier. Bash does not, so a pair of foreground bash calls is
correctly serialized.

To give the model a concrete way to request independent work together, the native
ChatGPT MCP server now exposes `dsh_parallel`. It accepts one to eight current
inventory tools, validates every entry before dispatch, starts all broker invocations
before awaiting any result, and returns ordered per-call results with individual
error states. The DSH scheduler remains authoritative for permissions, approvals,
concurrency-safe overlap, and serialization of exclusive tools. The safe/Zero Risk
contract does not expose this transport.

`tests/dsh-parallel.test.ts` uses the real MCP SDK in-memory transport and the real
Unix-socket broker. It proves three distinct calls (including a freeform call) are
delivered in one batch, mixed out-of-order success/failure/image results preserve
identity and order, invalid later entries never dispatch an earlier valid prefix,
schema limits are enforced, and safe mode excludes the tool. Full validation now
passes **132 tests, 0 failures, 987 assertions across 25 files**.

The prompt advertises the route only for the native external DSH connector and tells
the model not to batch dependent work or retry a partially completed batch. A live
ACP smoke after deployment (`5a889b71-8387-490d-bb48-f79e20b04175`) completed its
normal tool round trip and the captured browser prompt contained the current
`dsh_parallel` contract and turn token. It did not itself choose to call the batch
route; that remains a model-behavior question.

The deployed sidecar is PID 1907019, healthy with zero active turns after the smoke.
The build hashes are CLI `b4a72acd3a3a6d3456fd1b95c5f74c549f87bb9e40722a14ca9af121e2b0b031`
and plugin `ca4035a0867bc4c719f26d7329be146280c54ce04aac9b8580cef5845b8fa958`.
