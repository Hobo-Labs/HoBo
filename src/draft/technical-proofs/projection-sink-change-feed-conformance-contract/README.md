# Projection Sink Change-Feed Conformance Contract

HOBO-237 proof package for generalizing `change-feed` from a database-only capability to a `projection-sink` capability any sink provider can advertise.

The package proves:

- `change-feed` makes a projection sink reactive, including non-relational sink paradigms.
- Sinks without `change-feed` are typed and declared as `reactive: false`.
- `"use query"` over a non-reactive sink is surfaced as a `hobo doctor` warning.
- One-shot `snapshot` reads still work against non-reactive sinks.
- A sink claiming `change-feed` must emit ordered `data.Changed` events for insert/update/delete.
- Out-of-order, dropped-delete, and double-emitted changes fail the conformance suite.

Scope intentionally stops at the contract boundary: no Postgres or Mongo adapter implementation, no Reactor changes, and no provider driver code.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Projection Sink Change Feed Conformance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
