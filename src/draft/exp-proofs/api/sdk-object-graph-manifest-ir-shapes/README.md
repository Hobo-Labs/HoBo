# SDK Object Graph Manifest IR Shapes

This package is the executable experience proof for HOBO-568. It defines
SDK-facing example consumers for the `@hobo/bindles` object graph, generated
`hobo:sdk` binding names, `hobo.manifest/v1` manifest IR fixtures, typed
DeploymentPlan and migration-plan requests, and inspect/log subscription reader
shapes.

This is not a production `@hobo/bindles` package. It is a deterministic proof
that downstream API, CLI, MCP, docs, and launch-demo slices can cite without
inventing SDK semantics or hiding provider debt.

## Proof

Run the focused proof with:

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\sdk-object-graph-manifest-ir-shapes test
```

The package test first runs `tsc --noEmit` through the local `tsconfig.json` so
the compile consumers must typecheck before runtime assertions execute.

The tests prove:

- the HOBO-568 proof parses into a derived parsed record;
- app developer, platform engineer, and agent/MCP caller audiences are explicit;
- SDK examples compile as TypeScript interface shapes against `@hobo/bindles`
  and generated `hobo:sdk/*` binding names;
- the typecheck consumer binds manifest IR, resource references, DeploymentPlan,
  migration-plan, inspect-reader, and log-reader request shapes together;
- desired resource, provider/capability, DeploymentPlan, migration plan, and
  inspect/log reader examples all name deterministic fixture ids, inputs,
  outputs, and artifacts;
- `.raw()` and authoritative-external resource paths are marked as debt;
- live cloud calls, real package publishing, production bindings, provider
  execution, and new SDK semantics are rejected as scope creep; and
- protobuf, CUE, and Pact-style boundary evidence reconcile with the package.

## Architecture Evidence

- `architecture/sdk_object_graph_manifest_ir_shapes.proto` records the local
  data contract.
- `architecture/sdk_object_graph_manifest_ir_shapes.cue` constrains the same
  contract.
- `architecture/pacts/sdk_object_graph_manifest_ir_shapes.pact.json` records the
  mocked proof-registry boundary.
- `ADR.md` names the experience decision, parse boundary, event vocabulary, and
  alternatives.

## Scope

In scope:

- interface-only SDK example consumers;
- manifest IR fixture shape and generated binding names;
- proof-mode labels for simulated, reference-fixture, scope-out, and type-test
  examples;
- explicit debt markers for provider `.raw()` escape hatches and
  authoritative-external resources.

Out of scope:

- publishing real `@hobo/bindles`;
- generating production bindings;
- live cloud calls, real credentials, customer data, or provider execution;
- new SDK semantics beyond the WIT-first contract and thin idiom layer.
