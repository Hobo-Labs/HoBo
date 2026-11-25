---
type: Reference
title: "HOBO-535 Closure Builder Manifest Lowering Proof"
description: "Source issue: HOBO-535."
tags: [hobo, proof]
---

# HOBO-535 Closure Builder Manifest Lowering Proof

HOBO-535 is proven by the focused lowering contract at
[`src/draft/technical-proofs/closure-builder-manifest-lowering-contract`](../../../../src/draft/technical-proofs/closure-builder-manifest-lowering-contract/README.md).

## Acceptance Evidence

- Golden fixtures cover cache/API/queue dependency edges.
- Inert workload descriptor capture lowers into manifest data and a `hobo:sdk/workloads` call without
  executing app-host code.
- Generated IDs remain deployment identity; aliases are projected only as authoring metadata.
- Provider `.with(...)` annotations lower as inert provider-option annotations and do not resolve a
  provider.
- `dependsOn()` lowers to planner-compatible top-level relationships and resource `links` facets.
- The conformance report consumes the closure-builder lowering corpus and reports a passing case.

## Negative Coverage

- Lowering fails closed when a same-kind insertion fixture requires the persisted identity ledger
  owned by HOBO-538.
- Lowering does not execute runtime workload factories.
- Lowering does not emit provider or resolved-provider fields.

## Gate Evidence

- TypeScript proof: `corepack pnpm --prefix src/draft/technical-proofs/closure-builder-manifest-lowering-contract test`.
- Protobuf/CUE proof: `pnpm test:schema` checks repository schema validators while package-local data-model folders own indexed
  data model contracts including the lowering source module.
- PACT proof: `architecture/pacts/closure_builder_manifest_lowering.pact.json` pins the SDK
  conformance consumer expectation for the lowering boundary.
