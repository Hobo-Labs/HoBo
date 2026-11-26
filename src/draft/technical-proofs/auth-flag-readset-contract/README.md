# Auth/Flag Read-Set Contract POC

Independent POC for HOBO-269, proving auth-state and flag-state as Reactor read-set members.

## Contract

- `session.Started` / `session.Refreshed` / `session.Revoked` are principal-scoped auth-state inputs.
- `session.Revoked` recomputes affected subscriptions and pushes a fail-closed denial without a client poll.
- `flag.Defined` / `flag.Changed` are flag-state inputs keyed by flag ruleset key.
- `flag.Changed` wakes only subscriptions whose materialization declared that flag-state member.
- `ctx.flag(key)` fails fast unless `flagState:key` is declared, preventing hidden stale dependencies.
- A flag flip that narrows targeting re-pushes an empty/narrowed result to already-open subscriptions.
- Auth recompute errors deny and push an empty result rather than leaving privileged rows open.

## Scope

This package does not implement the full HOBO-80 Reactor, Streamer transport, session or flag event producers, bounded fan-out/coalescing, or high-cardinality backpressure. It proves the cross-cutting read-set contract that those components consume.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\auth-flag-readset-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Auth Flag Readset Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
