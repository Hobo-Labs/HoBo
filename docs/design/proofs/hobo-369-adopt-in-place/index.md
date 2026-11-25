# HOBO-369 Adopt-in-Place Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0041](../../adr/07-portability-extensibility.md#adr-0041).

## Acceptance Evidence

- `hobo import` of a fixture IaC state produces `adopted` nodes and emits
  `resource.Adopted`.
- Adopted nodes are retained and reconcile through drift-detect refresh only,
  never destroy, recreate, provision, or update.
- A managed resource binds across the brownfield boundary to an `external`
  resource and resolves declared outputs.
- Destroy plans skip adopted and external nodes.
- Import id collisions, wrong external output declarations, drift, and
  re-import idempotency are executable adversarial checks.

## Proof Boundaries

This is a contract POC. It does not implement Pulumi/CDKTF import reader
internals, the full migration playbook, echo-driver realization, real cloud
adapters, or the ResourceActor reconcile loop.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\adopt-in-place-contract test
```
