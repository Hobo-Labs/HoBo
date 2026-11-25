# HOBO-225 Adopt-in-Place Importers Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0041](../../adr/07-portability-extensibility.md#adr-0041).

## Acceptance Evidence

- Terraform-style IaC state imports into `adopted` graph nodes and emits
  `resource.Adopted`.
- Replaying the imported state is a no-op import plan rather than a destroy,
  recreate, provision, or update plan.
- Managed resources deploy with bindings to external brownfield outputs while
  adopted and external resources are skipped as unmanaged.
- PortabilityReport entries and zero-secret audit exceptions are generated for
  adopted dependencies, external dependencies, and static-key brownfield debt.
- Unsupported Terraform resources become `external` graph nodes with declared
  outputs instead of being force-adopted.
- Partial or corrupt IaC state fails closed before graph mutation.

## Proof Boundaries

This is a contract POC under `src/draft/technical-proofs/adopt-in-place-contract`. It does not
implement real Terraform, Pulumi, OpenTofu, or CDKTF state readers; the full
migration playbook; provider realization; or ResourceActor runtime reconciliation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\adopt-in-place-contract test
```
