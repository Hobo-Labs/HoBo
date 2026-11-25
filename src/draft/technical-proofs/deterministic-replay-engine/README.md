# Deterministic Replay Engine (HOBO-601 draft POC)

Independent draft POC for **S1-12 / HOBO-601**. Promotes the HOBO-60 equivalence spike and wires a typed replay engine surface ahead of `@hobo/runtime/replay` production promotion.

## Surface

- `createDeterministicContext` — seeded clock/random for deterministic zones (ADR-0086 §3).
- `assertReplayEqualsLive`, `seqVector`, `hashReadSet`, `interleaveStreams`, `stableValue`/`stableStringify` — fold equivalence harness from HOBO-60.
- `ReplayDivergenceError` + `parseReplayReport`/`parseReplayDivergence` — typed divergence and parse boundaries.
- `recordEffect`, `replayRun`, `createInMemoryEventStore` — effect recorder + replayer over an EventStore reader port.
- `testRuntime` + `defineWorkflow` — local replay==live invariant fixtures (checkout workflow, ambient-clock failure, memoized-step control).

## Promotion target

Production promotion path: `@hobo/runtime/replay` in `packages/runtime/src/replay/` (S1-12 / HOBO-601, promoted 2026-07-02). This draft POC remains as historical evidence.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/deterministic-replay-engine test
```

## Architecture evidence

This package ships architecture-guard evidence for `scripts/check-architecture-guardrails.mjs`:

- `architecture/replay_report.proto` + `replay_report.cue` — protobuf records with CUE constraints.
- `architecture/pacts/replayer_eventstore.pact.json` — replayer consumer ↔ EventStore provider PACT.
- `ADR.md` — parse-don't-validate derived types and event architecture vocabulary.

**Parse, don't validate:** `parseReplayReport` / `parseReplayDivergence` cross one boundary into parsed domain types.

**Event architecture:** workflow commands append `run.*` events to the event store; the workflow run actor replays by folding the stream into a materialized view; `ReplayReport.state_digest` is a snapshot digest over canonical state; downstream tests query the read store via `testRuntime().state()`.

## Related proofs

- `src/draft/technical-proofs/replay-live-equivalence-poc/` — HOBO-60 spike (equivalence semantics source)
- `src/draft/technical-proofs/local-dev-test-authoring-contract/` — `testRuntime()` replay fixture patterns
