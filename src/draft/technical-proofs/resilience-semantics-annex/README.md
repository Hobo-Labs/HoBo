# Resilience Semantics Annex POC

Independent POC for HOBO-516, extended by HOBO-518. It turns the DX SDK
resilience semantics matrix from `docs/design/dx-sdk-resilience-semantics.md`
into executable facts for the later SDK conformance lane.

## Requirements Source

- `docs/design/dx-sdk-resilience-semantics.md`: HOBO-515 vocabulary and target
  vectors.
- `docs/design/sdk-contracts.md`: SDK public-contract map and resilience
  conformance sequencing.
- `src/draft/technical-proofs/idiom-semantics-annex`: existing HOBO-31 semantics lane.
- `src/draft/technical-proofs/queue-clock-runtime-port-contract`: deterministic retry timing and
  clock facts.
- `src/draft/technical-proofs/runtime-local-execution-limits-contract`: interruption, cleanup,
  and audit-fact shape.
- `src/draft/technical-proofs/rollback-failure-compensation-contract`: fail-closed terminal and
  escalation posture.
- `src/draft/technical-proofs/runbook-execution-engine-contract`: persisted step facts and replay
  inspection posture.

## What This Proves

- Transient provider/runtime failure may retry only through a deterministic,
  seeded, budgeted schedule with persisted attempt facts.
- `policy.Decided{allow:false}` is terminal even when a provider also reports a
  transient failure.
- Typed terminal SDK failures never enter retry scheduling.
- Caller-owned cancellation stops pending retry work and emits cleanup facts.
- Deadline expiry escalates from persisted schedule/deadline state even when no
  fresh command attempt occurs.
- Replay-derived inspection reconstructs terminal state without re-running
  effects or incrementing counters.
- Lifecycle transition tables reject impossible state/event pairs with a stable
  failure code.
- Replay hydration reconstructs lifecycle state from persisted transition facts.
- Inspection snapshots are derived from persisted lifecycle events, not process
  memory.
- Post-terminal duplicates are ignored or refused without a second side effect.
- Child work that outlives its parent requires an explicit spawn contract.
- The HOBO-520 local diagnostics command renders replay-derived outcomes for a
  transient retry, policy denial, caller cancellation, and deadline expiry
  without implying retry after denial or treating process memory as
  authoritative.

## Report Shape

The public runner emits:

- `goldenIrLane`: explicitly not owned here; HOBO-32 owns WIT/manifest lowering.
- `existingSemanticsLane`: references HOBO-31 idiom semantics vectors.
- `resilienceSemanticsLane`: the HOBO-516 retry, denial, terminal, cancellation,
  deadline, cleanup, and replay vectors.
- `localDiagnostics`: the HOBO-520 command output and report shape that a
  developer can run locally.
- `unsupportedBehavior`: explicit scope guards for helper claims with no vector.

Stable case names:

- `transient-retry-schedule`
- `denial-never-retries`
- `terminal-never-retries`
- `cancellation-stops-retry`
- `deadline-escalates-from-state`
- `cleanup-after-interruption`
- `replay-no-effect-rerun`
- `lifecycle-transition-table`
- `lifecycle-replay-hydration`
- `lifecycle-event-derived-inspection`
- `terminal-duplicate-no-second-side-effect`
- `child-lifecycle-requires-spawn-contract`

## Adversarial Proof

Deliberately bad fixtures fail with stable codes:

- `resilience.denial_retried`
- `resilience.terminal_retried`
- `resilience.cancellation_retried`
- `resilience.deadline_not_escalated`
- `resilience.cleanup_missing`
- `resilience.replay_reran_effect`
- `resilience.retry_seed_missing`
- `lifecycle.illegal_transition`
- `lifecycle.snapshot_without_causative_event`
- `lifecycle.terminal_duplicate_side_effect`
- `lifecycle.child_outlived_parent`

## Lifecycle Convention Boundary

Use a lifecycle transition table when an SDK-visible actor, workflow, saga, or
runbook-like unit has meaningful impossible states, replay-derived inspection,
or parent/child lifetime obligations. A simple state enum is enough when a value
is display-only, has no illegal transition matrix, and does not drive cleanup,
retry, child work, or operator escalation behavior.

The table records state changes as `actor.StateAppended` facts and derives
inspection from those facts. It is not a generic statechart interpreter and does
not add XState, Effect, or any runtime scheduler dependency.

## Scope Boundary

This package does not add Effect, XState, `@statelyai/inspect`, a generic
statechart runtime, production `@hobo/conformance` integration, public SDK
syntax, provider implementation, or runtime scheduler behavior. It is only the
branch-sized executable annex contract that later issues can consume.

## Local Diagnostics

HOBO-520 adds one local command over the same persisted fixtures:

```powershell
npm.cmd --prefix src\draft\technical-proofs\resilience-semantics-annex run diagnostics
```

The command prints the exact scenario outcome, terminal causes, retry attempts,
cleanup facts, escalation facts, and source label:

- `transient-retry` shows the retry attempt chain and provider failure causes.
- `policy-denied` shows `policy.Decided` as terminal and has no retry wording.
- `caller-cancelled` shows caller cancellation plus cleanup facts.
- `deadline-expired` shows deadline expiration plus workflow escalation and no
  fresh post-terminal effect attempt.

What this does not guarantee: it is not a hosted inspector, polished UI,
production observability pipeline, scheduler, or SDK dependency on Effect or
XState. It is a replay-derived local diagnostic proof over persisted facts.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\resilience-semantics-annex test
npm.cmd --prefix src\draft\technical-proofs\resilience-semantics-annex run diagnostics
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- [`proto/resilience_semantics_annex.proto`](./proto/resilience_semantics_annex.proto) — protobuf data shapes for the spec, fixtures, facts, and case results.
- [`cue/resilience_semantics_annex.cue`](./cue/resilience_semantics_annex.cue) — CUE constraints for every protobuf type.
- [`contracts/pacts/resilience-conformance-lane.pact.json`](./contracts/pacts/resilience-conformance-lane.pact.json) — PACT for the SDK conformance-lane boundary.
- [`ADR.md`](./ADR.md) — parse-don't-validate and event-architecture evidence.
