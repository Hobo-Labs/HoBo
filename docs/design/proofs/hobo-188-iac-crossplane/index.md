# HOBO-188 Proof: Crossplane IaC Backend Contract

This proof records the branch-local evidence for the `@hobo/iac-crossplane`
adapter contract.

## Requirement Mapping

- Fixture `IacProgram` becomes Crossplane CompositeResourceClaims with concrete
  Composition selectors.
- `preview`, `apply`, `refresh`, and `destroy` exercise the same `IacProvider`
  lifecycle used by the Pulumi backend proof.
- `apply` waits for Ready and returns outputs from claim status.
- `refresh` detects out-of-band controller mutation as drift.
- Adversarial tests cover stuck Ready waits, missing CRDs, and zero or ambiguous
  Composition selector matches.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-crossplane-backend-contract test
```

## Scope Boundary

The proof is an in-memory contract harness. It intentionally does not build a
real Crossplane controller, Kubernetes provider, wasmCloud substrate, or other
IaC backend.
