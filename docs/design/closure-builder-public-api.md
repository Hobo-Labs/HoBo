---
type: Reference
title: "Closure Builder Public API"
description: "Canonical v1 public API contract for explicit Bindle authoring through @hobo/bindles."
tags: [hobo, design]
---

# Closure Builder Public API

Source issues: HOBO-531, HOBO-532, HOBO-533, HOBO-534, HOBO-535, HOBO-536, HOBO-537, and HOBO-538. This record is the v1 public contract for
explicit Bindle authoring in `@hobo/bindles`. It replaces pre-release
factory-object assembly examples with a closure builder that has one vocabulary
for agents, docs, and downstream implementation slices.

## Contract

```ts
import { bindle } from "@hobo/bindles";
import myApi from "@myproject/services";

export default bindle("shop", (b) => {
  const cache = b.cache();
  const api = b.api(() => myApi.run()).dependsOn(cache);

  return { cache, api };
});
```

- `bindle(name, builderFn)` belongs to `@hobo/bindles`.
- Bindle assembly creates provider-agnostic manifest objects. It is not an app
  host, request router, runtime, worker process, or framework adapter.
- Imported app-host or framework code owns request handling and process/runtime
  behavior.
- Resource builder methods such as `b.cache()`, `b.queue<T>()`, and
  `b.api(() => importedApp.run())` do not take resource name arguments in v1.
- Resource identity is HoBo-generated. Local variables and returned object keys
  are aliases for authoring, generated types, and downstream examples only.
- Generated identity is surfaced separately from aliases in diagnostics and
  physical naming seeds derive from the generated ID, not the local alias.
- Ambiguous same-kind insertions preserve existing generated IDs only through a
  collector-owned identity ledger artifact. The ledger maps kind occurrences to
  HoBo-generated IDs, records `collector-proposes-review-accepts` as its update
  flow, and crosses code review before downstream lowering consumes it.
- `dependsOn()` is the only v1 relationship verb and records a manifest-lowering
  relationship between handles.

## Scope

This contract pins public API vocabulary, package ownership, relationship
spelling, app-host boundary language, generated-identity separation, identity
ledger review artifacts, and the first manifest-lowering proof for downstream
HOBO-533 through HOBO-537 work.

Out of scope: runtime app-host behavior, provider resolution, public
resource-name factory arguments, alias-derived physical names, production
codegen, collection coverage, and end-to-end author flow proof.

## Proof

The public API vocabulary proof lives in
[`../../src/draft/technical-proofs/closure-builder-public-api-contract`](../../src/draft/technical-proofs/closure-builder-public-api-contract/README.md).
It includes TypeScript contract tests, protobuf shapes, CUE constraints, and a
Pact expectation for downstream SDK implementation work.

The resource-handle proof lives in
[`../../src/draft/technical-proofs/closure-builder-resource-handles-contract`](../../src/draft/technical-proofs/closure-builder-resource-handles-contract/README.md).
It proves anonymous handle creation, inert workload descriptors, invalid
dependency refusal, `dependsOn()` relationship emission, and inert provider
annotations. The same proof now covers HOBO-534 generated-ID stability, alias
separation diagnostics, and the HOBO-538 collector-owned identity ledger for
same-kind insertion stability.

The manifest-lowering proof lives in
[`../../src/draft/technical-proofs/closure-builder-manifest-lowering-contract`](../../src/draft/technical-proofs/closure-builder-manifest-lowering-contract/README.md).
It proves captured closure-builder facts lower to `hobo:sdk` calls and
`hobo.manifest/v1` while keeping aliases out of deployment identity and leaving
same-kind identity-ledger behavior to HOBO-538.

The tooling proof lives in
[`../../src/draft/technical-proofs/closure-builder-tooling-contract`](../../src/draft/technical-proofs/closure-builder-tooling-contract/README.md).
It proves that collection coverage, manifest collection, codegen bindings, and
`hobo new` scaffold samples consume the closure-builder contract while keeping
generated resource identities separate from returned aliases.

The end-to-end author-flow proof lives in
[`../../src/draft/technical-proofs/closure-builder-author-flow-contract`](../../src/draft/technical-proofs/closure-builder-author-flow-contract/README.md).
It names the v1 closure-builder corpus consumed by SDK conformance, keeps app-host code outside
Bindle assembly, proves cache/API/queue authoring, proves `dependsOn()` manifest edges, and
type-checks generated aliases without making aliases deployment identity.

The parent finalization proof lives in
[`../../src/draft/technical-proofs/closure-builder-v1-finalization-contract`](../../src/draft/technical-proofs/closure-builder-v1-finalization-contract/README.md).
It records that HOBO-532 through HOBO-538 have accepted evidence, keeps this
canonical public API record as the leading v1 Bindle authoring contract, and
rejects legacy explicit-Bindle syntax as a compatibility requirement.
