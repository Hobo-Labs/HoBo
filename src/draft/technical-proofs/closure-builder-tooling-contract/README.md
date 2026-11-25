---
type: Reference
title: "Closure Builder Tooling Contract"
description: "HOBO-536 proof for collection coverage, collect, codegen, and scaffold handling of closure-builder aliases."
tags: [hobo, proof]
---

# Closure Builder Tooling Contract

Source issue: HOBO-536.

This proof connects the v1 closure-builder authoring model to the tooling
surfaces that consume it: static collection coverage, `hobo collect`,
`hobo codegen`, and `hobo new` scaffolds.

## Scope

- Closure-builder resources declared by `b.cache()`, `b.api(...)`, and
  `b.queue<T>()` are recognized from returned aliases.
- Collection coverage fails closed when a declared closure-builder resource is
  not observed by collection.
- Manifest lowering uses HoBo-generated resource IDs and `dependsOn()` edges.
- Codegen emits typed bindings keyed by returned aliases while preserving
  generated IDs as resource identity.
- Scaffold proof emits the canonical closure-builder sample.

Scope out: production CLI wiring, runtime providers, a compatibility scaffold
for pre-v1 `b.use(database("db"))`, and any relationship verb beyond
`dependsOn()`.

## Acceptance Evidence

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\closure-builder-tooling-contract test
```

The test suite proves:

- closure-builder resources feed coverage, collect, and manifest lowering;
- generated aliases type-check without becoming resource IDs;
- generated alias consumers use explicit NodeNext-compatible import specifiers;
- unobserved closure-builder resources fail closed; and
- scaffolds use the canonical v1 closure-builder sample without pre-v1 syntax.

## Architecture Evidence

Protobuf data shapes live in [`architecture/`](./architecture). CUE constraints
bound every protobuf type. The Pact contract under
[`architecture/pacts/`](./architecture/pacts) records the consumer/provider
expectation between closure-builder tooling consumers and this proof package.

Parse, don't validate: source text crosses `evaluateClosureBuilderTooling` once
and becomes a derived `ClosureBuilderManifest`, `ClosureBuilderCoverage`, and
generated alias declaration model. Coverage, collect, and codegen consumers read
those derived records rather than reparsing broad source text.

Event architecture:

- Command: `EvaluateClosureBuilderTooling`.
- Event: `closureBuilder.ToolingEvaluated`.
- Actor: the SDK tooling actor owns one closure-builder authoring source snapshot.
- Event store: accepted tooling-evidence events append to the design-contract
  event store.
- Materialized view / projection: coverage, collect, codegen, and scaffold
  consumers read the manifest/codegen projection from that event.
- Snapshot: this package's tests and Pact contract are the review snapshot.
- Read store: downstream HOBO-537 end-to-end author-flow work consumes the
  snapshot instead of reinterpreting raw issue text.
