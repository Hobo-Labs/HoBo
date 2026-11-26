# Structured Log Pipeline Contract

Independent POC for HOBO-259. It pins the M2 `ctx.log` correlation and live-tail contract without
adding dashboard UI, metrics, traces, OpenInference payloads, or provider-specific log backends.

The contract proves:

- `ctx.log` records are structured and auto-tagged with `tenant`, `runId`, `resource`, and `traceId`.
- The `traceId` is derived from the enclosing W3C `traceparent`; malformed traceparents fail closed.
- Per-run live tail subscribers receive records before run completion.
- Historical export writes redacted records through a sink port.
- Level filtering drops below-threshold records before tail/export.
- Hot-loop floods are rate-limited without blocking run progress.
- Structured secret fields are redacted before tail and export.
- Disconnected tail subscribers do not collapse delivery to healthy subscribers.
- Concurrent producers in one run get monotonic per-run ordering.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\structured-log-pipeline-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Structured Log Pipeline Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
