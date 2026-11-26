# Resilience Semantics Annex — Architecture Evidence

This package is the HOBO-516 executable conformance annex, extended by HOBO-518
for SDK-visible lifecycle transition tables and by HOBO-520 for local
diagnostics. It carries the architecture evidence required by
`scripts/check-architecture-guardrails.mjs` so the annex states, rather than
implies, how its fixtures are parsed and how the resilience, lifecycle, and
diagnostic facts map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes for the spec, fixtures, facts, case results, and local
  diagnostic report live in
  [`proto/resilience_semantics_annex.proto`](./proto/resilience_semantics_annex.proto).
- CUE constraints for every protobuf type live in
  [`cue/resilience_semantics_annex.cue`](./cue/resilience_semantics_annex.cue).
- The retry-plan schema carries a deterministic seed. HOBO-517 consumes that
  seed through the SDK resilience lane before an idiom layer can claim retry
  helper parity.
- The lifecycle fact schema carries transition source/target states, causative
  event names, replay-inspection sources, child identifiers, and explicit spawn
  contracts so lifecycle fixtures remain protobuf-first rather than ad hoc
  object snapshots.
- The local diagnostic report schema names the run command, replay-derived
  source, terminal causes, retry attempts, cleanup facts, escalation facts, and
  explicit guarantee that persisted facts are authoritative.

## Parse, Don't Validate

`runResilienceCase` in
[`src/resilience-semantics-annex.mjs`](./src/resilience-semantics-annex.mjs)
applies the **parse, don't validate** discipline: each fixture's raw fact list is
parsed once into the derived domain types defined above — a `ResilienceFixture`
with ordered `ResilienceFact` events and a derived `ResilienceCaseResult` — and
downstream conformance reporting consumes those parsed, derived types rather than
re-inspecting the raw fixture. The CUE constraints bound the same derived types
so a malformed fixture is rejected at parse time, not silently passed downstream.
`buildLocalDiagnosticReport` follows the same rule for HOBO-520: persisted facts
become `LocalDiagnosticScenario` records, and object-memory snapshots are
rejected before rendering.

## Event Architecture

The annex is event-shaped: every fixture is an ordered fact (event) log, and the
assertions describe how a resilient workflow or SDK-visible lifecycle must
behave over that log.

- **Command** — a caller `AttemptEffect` command drives the workflow whose
  resilience behavior the fixtures certify.
- **Event** — each fact (`effect.Attempted`, `provider.Failed`, `retry.Scheduled`,
  `caller.Cancelled`, `cleanup.Emitted`, `workflow.Terminal`,
  `actor.StateAppended`, `inspection.StateSnapshot`, `child.Spawned`) is a
  domain event in the ordered log.
- **Actor** — the workflow actor owns retry, cancellation, deadline, and cleanup
  decisions and reaches a single terminal state per scenario. Lifecycle
  transition-table fixtures model SDK-visible actors/workflows/sagas without
  introducing a generic statechart interpreter.
- **Event store** — the ordered fact list is the append-only event store the
  annex replays to evaluate each case.
- **Materialized view / projection** — `runResilienceSemanticsAnnex` folds the
  per-case events into a projection (the suite result) for the conformance lane.
  `buildLocalDiagnosticReport` folds the same persisted facts into the local
  diagnostic projection for a developer or coding agent.
- **Snapshot** — each `ResilienceCaseResult` is the snapshot of a case's terminal
  outcome (passed/failed with code and reason).
- **Read store** — the SDK conformance lane reads those case-result snapshots
  and the local diagnostic command reads diagnostic snapshots rather than
  re-deriving them from process memory.

The `replay-no-effect-rerun` and `lifecycle-replay-hydration` cases explicitly
prove replay re-runs no effects and reconstructs state from persisted facts, so
the projection is a pure fold over the event store. No runtime SDK, provider,
statechart engine, or event store is implemented here; the annex only fixes the
resilience and lifecycle vocabulary and facts for the later conformance lane.
