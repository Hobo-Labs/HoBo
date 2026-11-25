# HOBO-143 Logs CLI Contract

Independent POC for `hobo logs [--follow] [<resource>]`. It pins the CLI
contract against a Camp runtime Streamer source without building the production
CLI shell, Gateway, Yard read API, dashboard, or the Streamer runtime port.

## What It Proves

- `logs --follow` receives live log lines from the runtime Streamer while the
  Yard is unreachable.
- A `<resource>` filter scopes output to one resource.
- `--tail <n>` returns a bounded recent window and exits when `--follow` is not
  present.
- `--json` emits one stable JSON object per line.
- Unknown resources fail explicitly instead of hanging on an empty stream.
- Transport drops and subscriber backpressure produce visible gap markers.
- Ctrl-C/abort closes the follow subscription with no orphaned subscriber.

## Scope Boundary

This package intentionally models the command against an in-memory
Streamer-backed log source. It does not implement the production CLI registry,
remote auth, historical projection storage, the dashboard live tail, or the
runtime Streamer itself.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-logs-cli-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Logs Cli Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
