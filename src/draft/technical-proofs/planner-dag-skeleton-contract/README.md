# Planner DAG Skeleton Contract POC

This package proves the M1 Planner slice for HOBO-61. It implements the first
pure Planner step from:

- `urn:hobo:requirement:control-plane`: collect manifest resources, build bind/link
  dependency edges, and emit a `DeploymentPlan`.
- `urn:hobo:requirement:platform-engineering`: co-provisioned resources become graph
  nodes with placeholder-wired inputs.
  by the Planner.

## Contract Surface

- `plan(manifest, config, registry)` is pure and cloud-free.
- Manifest resources lower into skeletal `ResourcePlan` nodes.
- `bind` and `links` lower into dependency DAG edges.
- Cycles fail before emitting a plan, with the cycle path in the error.
- Co-provisioning specs expand into extra nodes and `co-provisioned-output`
  edges.
- A valid `deployment.Planned` event is emitted with a content-addressed plan.

## Proof Boundaries

Provider matching, capability negotiation, region selection, objective ranking,
definition resolution, and manifest production stay out of scope for this slice.
Provider fields are deliberately stubbed as `stub-provider` / `planner-stub`.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\planner-dag-skeleton-contract test
```

The checks live in
`src/draft/technical-proofs/planner-dag-skeleton-contract/test/planner.test.ts`.


## Executable evidence
This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Planner Dag Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
