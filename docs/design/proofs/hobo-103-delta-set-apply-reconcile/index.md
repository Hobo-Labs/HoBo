# HOBO-103 Delta Set Apply Reconcile Proof

This branch adds `src/draft/technical-proofs/delta-set-apply-reconcile-contract`, an independent executable POC
for applying Deployment Deltas into immutable Deployment Sets and driving incremental reconciliation.

It proves:

- A non-empty Delta applies to a new content-addressed Set and emits `delta.Applied` plus `set.Created`.
- Reconcile only emits work for added, updated, or removed resources.
- Empty Deltas apply as explicit no-ops without minting a new Set.
- Removing a dependency chain destroys dependents before dependencies.
- A desired Set that keeps a dependent while removing its dependency fails closed.
- Rollback produces a Delta back to a prior Set only when an external compat gate passes.
- A post-contract rollback block is surfaced as `compat.GateFailed`, not silently applied.
- Environment-group promote resolves to promoted, partially promoted for optional member failure, or rolled back with compensation for required member failure.

Scope kept out: Gatekeeper/can-deploy internals, schema expand/backfill/contract implementation,
cross-Camp replication mechanics, real provider applies, drift detection, and DeploymentView graph projection.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\delta-set-apply-reconcile-contract test
```
