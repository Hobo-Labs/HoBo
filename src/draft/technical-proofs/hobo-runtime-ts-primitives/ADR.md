# Hobo Runtime TS Primitives — Architecture Evidence

Protobuf + CUE artifacts live under `architecture/`. PACT boundary under `architecture/pacts/`.

## Parse, Don't Validate

Raw event envelopes cross exactly one parser boundary in `src/engine/events.ts`. Downstream
code accepts only `ParsedEnvelope` derived types.

## Event Architecture

- **Command** — workflow start, actor signal, saga subscription.
- **Event** — catalog types only: `run.*`, `actor.*`, `saga.*` from Plan 11.
- **Actor** — single-writer aggregate behind ActorHost lease + fence token.
- **Event store** — append-only run/saga streams via camp-eventstore draft mock.
- **Materialized view** — workflow result and actor state are folds over appended events.
- **Snapshot** — step memoization via `run.StepCompleted` cache entries.
- **Read store** — `testRuntime().state()` derives current outcome from the log.

This draft POC promotes to `packages/runtime/` and `packages/events/` when S1-01/S1-05/S1-06 merge.
