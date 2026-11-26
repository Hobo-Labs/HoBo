---
type: Design Proof Evidence
title: "HOBO-537 Closure Builder Author Flow Proof"
description: "Proof record for making the closure-builder corpus the v1 SDK authoring path."
tags: [hobo, proof, closure-builder, sdk]
timestamp: 2026-06-30T00:00:00Z
---

# HOBO-537 Closure Builder Author Flow Proof

HOBO-537 makes the closure-builder corpus the v1 SDK authoring path for examples, docs, and
conformance.

## Evidence

- Proof package:
  [`closure-builder-author-flow-contract`](../../../../src/draft/technical-proofs/closure-builder-author-flow-contract/README.md)
- Corpus path:
  `src/draft/technical-proofs/closure-builder-author-flow-contract/src/closure-builder-author-flow.ts#buildClosureBuilderAuthorFlow`
- Conformance suite:
  `@hobo/conformance/sdk/closure-builder-author-flow`

## Acceptance Mapping

- Sample Bindle declares cache, API, and queue resources.
- `dependsOn()` lowers to `hobo.manifest/v1` relationships and API link facets.
- Generated aliases type-check through `test/type-fixtures/closure-builder-author-flow.fixture.ts`.
- Generated resource IDs remain deployment identity; aliases are authoring keys only.
- App-host code stays outside Bindle assembly: `b.api(() => myApi.run())` records an inert workload
  factory and never owns request routing or runtime startup.

## Scope Boundary

No provider deploy implementation, old-example migration guide, app-host runtime, or same-kind
identity ledger is implemented here. HOBO-538 owns the same-kind ledger gap.
