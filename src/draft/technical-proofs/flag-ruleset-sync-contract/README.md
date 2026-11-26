# Flag Ruleset Sync Contract

Executable POC for HOBO-326. It proves the Streamer/event-log sync boundary
that keeps in-process feature-flag evaluators current without moving evaluator
logic into this slice.

The package consumes `flag.*` entries from `src/draft/technical-proofs/flag-event-contract` and
the existing built-in evaluator from `src/draft/technical-proofs/built-in-flag-store-contract`.
It owns only the sync coordinator:

- subscribed evaluators advance monotonically to the latest `seq`;
- reconnect rebuilds from snapshot plus tail and matches a full replay;
- disconnected or backpressured evaluators serve last-known rulesets with a
  stale freshness label;
- out-of-order delivery never regresses an evaluator;
- healthy evaluators keep receiving updates while a slow evaluator builds
  backlog;
- local evaluation performs no per-eval network fetch.

Run:

```text
npm.cmd --prefix src\draft\technical-proofs\flag-ruleset-sync-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Flag Ruleset Sync Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
