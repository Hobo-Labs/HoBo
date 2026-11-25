---
type: Reference
title: "Closure Builder V1 Finalization Contract"
description: "HOBO-531 proof that the closure-builder v1 parent issue is ready to close after child evidence is accepted."
tags: [hobo, proof]
---

# Closure Builder V1 Finalization Contract

Source issue: HOBO-531.

This proof closes the parent closure-builder v1 API item without reimplementing
child scope. It verifies that the accepted child/RCR evidence for HOBO-532
through HOBO-538 is present, Done, and mapped to the canonical public design
record that makes closure builder the explicit v1 Bindle authoring model.

## Scope

- Confirm child/RCR evidence exists for HOBO-532, HOBO-533, HOBO-534,
  HOBO-535, HOBO-536, HOBO-537, and HOBO-538.
- Confirm each accepted evidence record links a `src/draft/` proof package and
  a `docs/design/` system-of-record page.
- Confirm v1 public docs lead with `bindle(name, builderFn)` from
  `@hobo/bindles`.
- Reject legacy explicit-Bindle vocabulary such as `b.use(...)`, named builder
  resource arguments, and relationship verbs other than `dependsOn()`.

Scope out: new builder behavior, manifest lowering behavior, production
codegen, runtime providers, app-host execution, and compatibility with
pre-release `b.use(database("db"))` examples. Those remain child issue scope.

## Acceptance Evidence

Run:

```powershell
corepack pnpm -C src\draft\technical-proofs\closure-builder-v1-finalization-contract test
```

The test suite proves:

- the HOBO-531 parent record carries every accepted child/RCR issue;
- every child/RCR evidence row is Done and points at branch proof;
- design docs index the closure-builder public API as the v1 Bindle authoring
  contract and link this finalization proof; and
- traceability carries both the parent row and the child rows.

## Architecture Evidence

Protobuf data shapes live in [`architecture/`](./architecture). CUE constraints
bound every protobuf type. The Pact contract under
[`architecture/pacts/`](./architecture/pacts) records the consumer/provider
expectation between the parent release-readiness consumer and this
closure-builder finalization evidence.

Parse, don't validate: untrusted finalization records cross
`assertClosureBuilderV1Finalization` once and become parsed derived domain
types (`ClosureBuilderV1FinalizationRecord` and
`ClosureBuilderEvidenceEntry`). Core checks consume those parsed records rather
than broad raw DTOs.

Event architecture:

- Command: `FinalizeClosureBuilderV1Api`.
- Event: `closureBuilder.V1FinalizationAccepted`.
- Actor: the SDK contract actor owns the parent closure-builder finalization
  record.
- Event store: accepted finalization evidence events append to the
  design-contract event store.
- Materialized view / projection: release readiness and SDK documentation
  consumers read the closure-builder v1 finalization projection.
- Snapshot: this package's tests, README, and Pact fixture are the review
  snapshot.
- Read store: downstream v1 docs and release-readiness records consume the
  finalization snapshot instead of reinterpreting raw Linear issue text.
