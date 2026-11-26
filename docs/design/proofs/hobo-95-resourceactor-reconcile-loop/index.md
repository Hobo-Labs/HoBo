# HOBO-95 ResourceActor Reconcile Loop Proof

This branch adds `src/draft/technical-proofs/resourceactor-reconcile-loop-contract`, an independent executable POC
for the ResourceActor idempotent load -> diff -> apply -> outputs loop.

It proves:

- A fixture resource with non-empty preview dispatches one Executor program and reaches
  `resource.Provisioned` with outputs captured.
- A second loop on converged state emits no events and dispatches no work.
- `exec.Failed` maps to `resource.Failed` while preserving retryable versus fatal classification.
- Outputs resolve into a dependent's bindings before that dependent activates.
- A clean preview with dirty apply state fails closed without dispatching.
- Duplicate `exec.Succeeded` settlement is idempotent.

Scope kept out: periodic resync trigger, drift detection, compensation/rollback, driver-taxonomy
routing, Executor sandbox internals, and real IaC adapter internals.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\resourceactor-reconcile-loop-contract test
```
