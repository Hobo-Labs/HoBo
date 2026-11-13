# Post-Core Cross-Cutting Delta Pattern - Architecture Evidence

HOBO-524 is a docs-pattern hardening proof. This package does not implement broker runtime,
project automation, broad backlog migration, Yard planner behavior, provider adapters, admin UI, or
Gatekeeper policy behavior. It records the architecture evidence for a documentation system-of-
record boundary that admits post-core capability deltas.

## Schema Sources Of Truth

- **Protobuf** - `proto/post_core_delta_pattern.proto` defines the data shapes for
  `PostCoreDeltaRecord`, `DeltaArtifactEvidence`, `DeltaTraceabilityRecord`, and
  `DeltaGateDecision`.
- **CUE** - `cue/post_core_delta_pattern.cue` constrains every protobuf type so a delta cannot be
  ownerless, proofless, or unlinked from traceability.
- **PACT** - `contracts/pacts/post-core-delta-pattern.pact.json` is the executable PACT contract
  for the boundary between a post-core delta author and the HoBo design system of record.

## Parse, Don't Validate

Raw issue and docs inputs are parsed once into **derived domain types** before the design suite can
accept them:

- A raw capability proposal becomes a `ParsedPostCoreDeltaRecord` only after it names a Linear
  project, M0 acceptance record, design index row, proof README, traceability row, and blocked
  follow-up skeleton.
- A raw proof reference becomes a `ParsedDeltaArtifactEvidence` only after it has an executable
  proof path and source issue.
- A raw traceability entry becomes a `ParsedDeltaTraceabilityRecord` only after the source record
  and proof package resolve.

Following parse, don't validate, design docs consume parsed types
only. Completed-epic catch-alls and docs-only claims are unrepresentable past this boundary.

## Event Architecture

The later automation is intentionally out of scope, but the event boundary is named so follow-up
issues do not invent conflicting system-of-record behavior:

- **Command** - `RecordPostCoreDelta` asks the design system of record to admit a new
  cross-cutting capability delta.
- **Events** - accepted commands emit `PostCoreDeltaRecorded`; refused commands emit
  `PostCoreDeltaRejected`.
- **Actor** - the design-record actor is the single writer for a capability plus source issue
  stream.
- **Event store** - delta record events append to the docs governance event-store.
- **Materialized view / projection** - a projection builds the design-index
  and traceability coverage view.
- **Snapshot** - snapshots bound replay cost for the coverage projection without changing accepted
  delta authority.
- **Read store** - the reviewer read store exposes only accepted record, proof, and gate metadata.

This evidence keeps HOBO-524 scoped to docs hardening and executable proof. Project creation
automation, backlog migration, broker runtime, and follow-up implementation remain separate issues.
