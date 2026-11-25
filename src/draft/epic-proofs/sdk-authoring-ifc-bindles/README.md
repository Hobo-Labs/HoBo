# SDK & Authoring Reference Implementation

> **Runtime primitives (draft):** durable workflow/step/actor/saga TS surface is exercised in [`hobo-runtime-ts-primitives/`](../../technical-proofs/hobo-runtime-ts-primitives/) (HOBO-600); epic scenarios will wire it once `@hobo/runtime` lands in `packages/`.

This epic reference implementation rolls the SDK and IfC authoring POCs into one common architecture slice for app authors.

It demonstrates an app developer declaring resources, config, handlers, XAA access, auth, topology, and Hobo Code DSL input, then lowering all authoring front doors to one deterministic `hobo.manifest/v1` with mocked boundaries.

Included lower-layer proofs:

- `src/draft/technical-proofs/hobo-code-dsl-contract` — validated DSL input
  boundary hardening while preserving canonical AST, manifest parity, and
  codegen behavior.
- `src/draft/exp-proofs/api/xaa-scope-inference-contract` — XAA scope
  inference and widening denial.

## What is real

- Deterministic reference service that models the epic vertical slice.
- Consumer tests for SDK authoring behavior and adversarial cases.
- Pact-format fixtures for every modeled internal and external boundary.
- Simulation harness with local mocked provider/runtime boundaries only.

## What is mocked

- `hobo:sdk` WIT collector and generated bindings.
- Capability Manifest/auth registry for XAA typed-client metadata.
- Local Camp runtime, provider mock catalog, and secret source resolver.
- SDK conformance and non-TypeScript parity report providers.

## What is deferred

- Production `@hobo/bindles` package implementation.
- Real WIT codegen, jco/wit-bindgen, and provider selection.
- Live cloud deploys, external IdPs, and live external app OAuth.

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/sdk-authoring-ifc-bindles run simulate
```

What this proves:

- App author declares a sample Bindle through IfC and receives a deterministic manifest and generated type surface.
- Narrowing, collection coverage, XAA scope widening, and raw portability debt fail or surface before deploy.
- Hobo Code DSL and non-TypeScript parity are treated as front-end lowering concerns, not new runtime semantics.
- The XAA scope-inference API proof's boundary-type hardening is included in this rollup; its simulation contract is unchanged.
- The validated Hobo Code DSL proof's boundary-type hardening is included in this rollup; its simulation contract is unchanged.
- Bindles resource-catalog changes are absorbed without changing manifest lowering or secret-reference behavior.

Mocked boundaries:

- SDK WIT collector, manifest registry, coverage gate, permission gate, XAA auth registry, codegen workspace, local runtime, topology lowerer, DSL parser, auth consumer contract, secret source resolver, and SDK parity report provider.

Contracts:

- `src/draft/epic-proofs/sdk-authoring-ifc-bindles/contracts/pacts/*.pact.json`


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sdk Authoring Ifc Bindles.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The SDK-codegen, topology-object, and usage-permission technical proof refreshes are absorbed without changing SDK authoring or bindle evidence.
