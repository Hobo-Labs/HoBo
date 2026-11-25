# Closure Builder Public API Contract

Source issue: HOBO-532.

This proof pins the v1 public `@hobo/bindles` closure-builder vocabulary before
downstream builder, identity, lowering, tooling, and end-to-end author-flow work
starts.

## Scope

- `bindle(name, builderFn)` is manifest assembly only.
- Imported app/framework code owns app-host behavior.
- Builder resource factories such as `b.cache()` and `b.api(...)` take no
  resource-name argument in the v1 explicit Bindle surface.
- Local variables and returned object keys are aliases only. Resource identity is
  HoBo-generated.
- `dependsOn()` is the only v1 relationship verb.

Scope out: runtime app-host behavior, manifest lowering, codegen, collection
coverage, generated resource identity implementation, and end-to-end author-flow
proofs. Those belong to HOBO-533 through HOBO-537.

## Proof

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\closure-builder-public-api-contract test
```

The tests assert:

- Bindle docs cannot claim app-host behavior.
- Legacy `b.use(database("db"))` explicit Bindle examples are rejected.
- `@hobo/sdk` cannot become the app-authoring package for this surface.
- `dependsOn()` remains the only relationship verb.
- A coding agent can read the checklist and continue HOBO-533 through HOBO-537
  without inventing new vocabulary.

## Architecture Evidence

Protobuf data shapes live in [`architecture/`](./architecture). CUE constraints
bound every protobuf type. The Pact contract under
[`architecture/pacts/`](./architecture/pacts) records the consumer/provider
expectation between downstream SDK implementation work and this public API
contract.

Parse, don't validate: untrusted contract records are parsed once by
`parseClosureBuilderContract` into derived domain types. Core assertions accept
the parsed/derived `ClosureBuilderContract` shape rather than broad DTO values.

Event architecture:

- Command: `DefineClosureBuilderPublicApi`.
- Event: `closureBuilder.PublicApiPinned`.
- Actor: the SDK contract actor owns one versioned closure-builder vocabulary.
- Event store: accepted public API pin events append to the design-contract event
  store.
- Materialized view / projection: the closure-builder API matrix projects the
  latest accepted package, factory, relationship, and scope rows.
- Snapshot: reviewers inspect the current contract snapshot in this package and
  the design docs.
- Read store: downstream HOBO-533 through HOBO-537 work reads the snapshot
  instead of reinterpreting raw issue text.
