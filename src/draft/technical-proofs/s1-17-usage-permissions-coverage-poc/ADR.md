# S1-17 usage permissions + collection coverage draft POC

## Status

Accepted — draft POC for HOBO-607 pending S1-16 collector promotion.

## Context

HOBO-607 requires least-privilege permissions inferred from usage, narrow-only
`.allow()`, capability-contract failures for narrowing below usage, and a
static-analysis collection-coverage gate that fails closed on unobserved or
unprovable resource declarations.

## Decision

1. **Single granted set drives three legs.** `projectPermissionTriple` derives
   IAM verbs, wasm link allow, and token scope from one `link.allow` array —
   never computed independently.
2. **Parse-don't-validate.** Raw manifest input crosses `parseUsagePermissionInput`
   once into parsed derived types; `buildUsagePermissionManifest` accepts only
   those parsed derived types.
3. **Narrowing below usage is a gate failure, not a throw.** Records
   `capability.required-not-granted` with `contractStatus: "failed"`.
4. **Widening throws.** Unmarked `.allow()` beyond observed usage throws
   `PermissionContractError` `capability.allow-widens-usage`.
5. **CQRS gate events.** Evaluations append `capability.*` and `coverage.*` events;
   machine-readable results are projections, not mutated read models.
6. **Coverage analyzer import provenance.** Only `@hobo/bindles` named/namespace
   imports count as resource factories; local shadow names are ignored.

## Schema and constraints

- Protobuf data shapes live in [`data-models/`](./data-models/).
- CUE constraints bound every protobuf type in that schema.
- PACT contracts under [`contracts/`](./contracts/) record gate boundaries.

## Parse, don't validate

This package applies the **parse, don't validate** discipline: untrusted input is
parsed once at `parseUsagePermissionInput` into derived domain types, and
downstream gate functions receive those parsed derived types instead of
re-checking raw DTO fields. CUE constraints bound the same derived types so
malformed input is rejected at parse time.

## Event architecture

Gate evaluations follow a small CQRS flow:

- **Command** — `evaluateCapabilityContract` / `evaluateCollectionCoverage`
  requests a gate verdict for a bindle source file.
- **Event** — successful or failed evaluations append `capability.ContractEvaluated`,
  `capability.ContractFailed`, `coverage.Evaluated`, or `coverage.Failed` to the
  collection event log.
- **Actor** — the collector gate actor owns ordering and never mutates prior events.
- **Event store** — gate events append to the durable collection event store
  introduced by S1-16 (simulated in-memory in this draft POC).
- **Materialized view / projection** — `UsagePermissionManifest`, `CoverageResult`,
  and `PermissionTriple[]` are projections folded from the appended events.
- **Snapshot** — the returned manifest/result objects are the current-read snapshot
  of those projections.
- **Read store** — `can-deploy` and agents query the snapshot read store, not the
  raw event log directly.

No runtime projector or persistent event store ships in this draft; the vocabulary
names the command, event, actor, projection, snapshot, and read-store boundaries
for S1-16 promotion.

## Consequences

- Draft POC is self-contained under `src/draft/technical-proofs/s1-17-usage-permissions-coverage-poc/`.
- Production promotion moves modules to `packages/collector/` and extends
  `@hobo/bindles` without changing semantics proven here.
