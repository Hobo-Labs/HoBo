# Reads-Your-Writes Contract POC

Independent POC for HOBO-85, composing the existing HOBO-69 CQRS command runtime and
HOBO-80 Reactor skeleton.

## Contract Surface

- `createReadYourWritesRuntime(...)` executes a command, appends emitted events to the native
  Reactor path, and returns the command ack only after affected subscriptions have recomputed to
  at least the command's `{ streamId: seq }` floor.
- `assertAckAdvanced(...)` is the fail-closed guard for an ack that would return before the
  subscription position reaches the command seq.
- `classifyReadGuarantee(...)` labels native log-backed reads as strict `read-your-writes` and
  change-feed sink reads as `bounded-staleness`.
- Client-observed seq tracking rejects lower per-stream seq vectors, preserving monotonic ordering.

## Acceptance Evidence

- Command ack waits until a native subscription advances to the command seq.
- Multi-stream materializations advance with a per-stream seq vector, not a scalar.
- A stale/before-advance ack is detectable.
- Client pushes cannot regress a stream seq.
- Change-feed sink reads are labeled bounded-staleness, not strict reads-your-writes.

## Scope Boundary

This package does not implement the `change-feed` sink adapter, tunable consistency levels,
cross-Camp bounded-staleness, GraphQL facade, or Reactor scheduling/backpressure. It proves only
the HOBO-85 contract over the existing native Reactor/CQRS surfaces.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\reads-your-writes-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Reads Your Writes Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
