# HOBO-132 - `hobo down` Lifecycle Contract Proof

This proof covers the branch-local POC at
[`src/draft/technical-proofs/hobo-down-lifecycle-contract`](../../../../src/draft/technical-proofs/hobo-down-lifecycle-contract).

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| `hobo down --camp <c>` removes provisioned resources in reverse dependency order. | `tears down a Camp in reverse dependency order and proves it through events` |
| Event log proves teardown completion. | Same test asserts `deployment.DownStarted`, per-resource destroy events, and `deployment.DownCompleted`. |
| A second `down` is a clean no-op. | `second down is an idempotent success with nothing left to destroy` |
| Destroy on a prod-typed Camp requires explicit confirmation/approval. | `prod-typed Camp requires explicit confirmation or approval before destroy` |
| `--json` can enumerate removed and pending resources. | Contract result exposes `json.removedResources`, `json.pendingResources`, and event summaries. |

## Adversarial Mapping

| Edge case | Executable proof |
|---|---|
| Partial teardown is resumable and never reports success while resources remain. | `partial teardown is resumable and never reports success while resources remain` |
| A resource another live Camp still depends on is refused with the dependent named. | `refuses to destroy a resource still depended on by another live Camp` |
| Unknown `--camp` errors clearly. | `unknown Camp errors clearly before any destroy attempt` |
| Destroying nothing is success, not an error. | `destroying an empty Camp is success, not an error` |

## Scope Boundary

The POC consumes fake apply/compensation/provider seams. It does not implement `hobo up`,
choreographed rollback, provider destroy adapters, policy approval rules, or incident handling.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-down-lifecycle-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```
