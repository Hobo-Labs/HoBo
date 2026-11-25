# @hobo/iac-crossplane backend contract

Independent proof for HOBO-188. The package models `@hobo/iac-crossplane` as an
`IacProvider` adapter over the existing `IacProgram` shape, using an in-memory
Crossplane cluster fixture instead of a real kind/k3d cluster.

## Proven behavior

- `preview(program)` renders the desired CompositeResourceClaims and returns a
  typed diff before apply, then a clean diff after convergence.
- `apply(program)` verifies Crossplane CRDs, resolves Composition selectors,
  applies claims, waits for managed resources to become Ready, and returns
  outputs from claim status.
- `refresh(program)` reports clean state after convergence and reports drift
  when a controller mutates claim spec or observed status out of band.
- `destroy(program)` deletes fixture claims and returns destroyed outputs.
- The conformance smoke suite proves preview, apply, refresh, and destroy use
  the same backend shape as the other IaC adapters.

## Adversarial coverage

- A managed resource stuck non-Ready returns a bounded `ready-timeout` instead
  of hanging.
- A Composition selector matching zero or multiple Compositions fails closed.
- Missing Crossplane CRDs fail before apply.
- Out-of-band controller mutation is surfaced as deterministic drift, never
  treated as convergence.

## Scope boundaries

This is a contract POC. It does not provision a real Kubernetes cluster, install
Crossplane, implement provider-kubernetes, manage wasmCloud operators, or replace
Pulumi/OpenTofu/CDKTF adapters. Those remain separate slices.

## Check

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-crossplane-backend-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac Crossplane Backend Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
