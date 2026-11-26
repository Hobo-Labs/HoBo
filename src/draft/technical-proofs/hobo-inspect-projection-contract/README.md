# HOBO-140 Inspect Projection Contract

This POC pins the `hobo inspect run|deploy|topology` read-only contract without
building the production CLI, Gateway, runtime, or dashboard. It models the
command against fixture RunView, DeploymentView, and TopologyView projections
rebuilt from an event log.

## What It Proves

- `inspect run --last` renders the most recent local run timeline without auth.
- `inspect run <id> --at <seq> --json` returns a stable JSON envelope and
  reproduces historical state.
- `inspect topology --json` lists resolved providers and bind edges.
- Rebuilding projections from zero yields the same view as the live query.
- Unknown ids, beyond-head `--at`, and remote inspect without an SVID fail
  closed with explicit messages.

## Scope Boundary

This package intentionally consumes projections as fixtures. It does not build
the production projections/read API, live tailing, Streamer integration, web
dashboard, auth broker, or the full HOBO-115 CLI shell.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-inspect-projection-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Inspect Projection Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
