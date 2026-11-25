# HOBO-217 IaC Drift Refresh Fidelity Proof

This proof pins the M3 hardening contract for provider `refresh() -> DriftReport` fidelity.

## Requirement Links

- [Control plane plan 04](../../control-plane.md#plan-04)
- [Control plane IaC state model](../../control-plane.md#iac-state-model)
- [Generated stack plan 09](../../generated-stack.md#plan-09)
- [ADR-0042 local-dev and test-environment fidelity](../../adr/07-portability-extensibility.md#adr-0042)

## Acceptance Matrix

| Requirement | Executable proof |
|---|---|
| Out-of-band mutation is reported exactly. | `reports out-of-band update, delete, and create drift exactly` |
| Provider-normalized fields do not produce false drift. | `ignores provider-normalized fields that would otherwise cause perpetual false drift` |
| Level-triggered resync converges and the second pass is a no-op. | `converges once after drift and makes the second reconcile pass a no-op` |
| Adopted nodes report drift but are not destroyed or recreated. | `records adopted resource drift without destroying or recreating the adopted node` |
| Co-provisioned child drift does not dirty the parent. | `attributes co-provisioned child drift without dirtying the parent` |
| Flaky refresh implementations are rejected by camp conformance. | `requires camp-tagged conformance and catches flaky refresh misses` |

## Scope Boundary

The draft package models only refresh fidelity, report classification, and an idempotent managed
reconcile proof. It intentionally leaves the production drift loop, automatic remediation policy,
ResourceActor resync trigger, and adopt-in-place importer to their owning issues.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-drift-refresh-fidelity-contract test
```
