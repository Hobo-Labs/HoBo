# ADR: Compose Plan/Diff Review Prototype From Accepted M1 Plan Proofs

## Status

Accepted for HOBO-560 proof work.

## Context

HOBO-560 asks for a deterministic plan/diff review prototype over golden
fixtures. The upstream M1 slices already define plan review states (HOBO-542),
annotation pseudocode (HOBO-543), and canonical resource-lifecycle quickstart
fixture ids (HOBO-577). Recreating those surfaces here would drift from
accepted evidence and risk inventing production behavior.

## Decision

The prototype is a thin composition layer over the accepted M1 proofs and
HOBO-577 quickstart references. It parses both upstream proof exports, pins the
accepted quickstart fixture ids and proof-mode labels, then maps plan review
states and annotation pseudocode into seven golden fixtures: create, update,
no-op, destructive, blocked, stale, and unknown-evidence. Every fixture carries
source issue, evidence source, owner, policy/cost/capacity disposition,
annotation refs, safe next action, proof mode, and a redacted support handoff
packet.

## Consequences

- Downstream vibe artifacts get one deterministic plan/diff review shape without
  importing live providers or plan runtime.
- Blocked, destructive, stale, and unknown-evidence states are represented as
  reference/simulated/scope-out evidence from accepted M1 records instead of
  optimistic live claims.
- Policy, cost, capacity, and approval remain annotation dispositions, not
  enforcement or billing systems.

## Parse Boundary

The package follows parse, don't validate discipline at the proof boundary.
Unknown input enters `parseVibePlanDiffReviewPrototype` once and becomes the
parsed derived type `VibePlanDiffReviewPrototype`. Nested constrained values
become derived types such as `GoldenPlanDiffFixture`, `PlanDiffAnnotationRef`,
and `PlanDiffSupportHandoff`.

## Event Architecture

The event architecture is named without implementing runtime infrastructure.
The plan/diff consumer command is `RenderPlanDiffReviewPrototype`. Source events
are `PlanReviewStateAccepted`, `PlanAnnotationComposed`, `PlanDiffGoldenFixtureBuilt`,
`PlanDiffBlocked`, `PlanDiffStaleEvidence`, `PlanDiffUnknownEvidence`, and
`SupportHandoffRouted`. Actors are `PlanReviewActor`, `PlanAnnotationActor`,
`PlanDiffProjectionActor`, and `SupportHandoffActor`. The event-store expectation
is replayable plan review and annotation history from accepted HOBO-542 and
HOBO-543 fixtures plus HOBO-577 quickstart fixture ids. Materialized views and
projections are the golden plan/diff fixture records composed from upstream M1
proofs. Snapshots are the parsed golden fixture states with policy, cost,
capacity, and annotation disposition labels. Read store behavior is fixture-only
reference reads for downstream vibe surfaces; this proof does not implement a
production read store, subscription, or approval runtime.

## Gates

- TypeScript: `test/vibe-plan-diff-review-prototype.test.ts`
- Protobuf: `architecture/proto/vibe_plan_diff_review_prototype.proto`
- CUE: `architecture/vibe_plan_diff_review_prototype.cue`
- Pact: `architecture/pacts/vibe_plan_diff_review_prototype.pact.json`
