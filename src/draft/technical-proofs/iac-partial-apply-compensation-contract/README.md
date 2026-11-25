# IaC Partial Apply Compensation Contract

HOBO-214 proves the provider/IaC primitive needed when `apply()` fails after
some resources exist but before the resource slice has converged.

## Scope

- `createIacBackendHarness()` models `iac-pulumi` and `iac-opentofu` backends
  with the same per-resource stack contract.
- `applyResourceSlice()` applies one resource stack, records state, classifies
  failures, adopts tagged orphans on retry, and refuses false success reports.
- `destroyPartialSlice()` destroys recorded state plus tagged orphans for one
  stack key only.
- `compensateNoGoDeployment()` composes the per-stack primitive for a fixture
  no-go-threshold rollback without implementing the Orchestrator saga engine.

## Proven behavior

- A mid-program apply failure leaves accurate state for `destroy()`.
- Retried `apply()` converges idempotently and does not double-create even when
  the provider create operation itself is non-idempotent.
- Created-before-state-write resources are swept by tag.
- Apply errors surface precise retryable/fatal classifications.
- A fixture no-go deployment compensates to zero residue.
- Destroy failure during compensation escalates with remaining residue.
- A provider "success" report that mismatches reality is fatal, not provisioned.

## Scope boundaries

This POC does not implement the ResourceActor FSM, reverse-dependency DAG
traversal, production Pulumi/OpenTofu adapters, real cloud calls, or drift
detection. It pins the per-resource stack primitive those slices rely on.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\iac-partial-apply-compensation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Iac Partial Apply Compensation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
