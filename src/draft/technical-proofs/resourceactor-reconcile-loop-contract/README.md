# ResourceActor Reconcile Loop Contract

Independent POC for HOBO-95. It composes the ResourceActor FSM boundary, Executor skeleton,
control-plane event schema, and DeploymentPlan placeholder grammar into the idempotent
load -> diff -> apply -> outputs loop.

The contract proves:

- A non-empty `IacProvider.preview` dispatches exactly one `IacProgram` to Executor work.
- Successful executor completion records outputs and emits `resource.Provisioned`.
- A second loop over converged state emits no new events and dispatches no work.
- `exec.Failed` becomes `resource.Failed` with retryable or fatal classification preserved.
- Resource outputs resolve into dependent bindings without activating the dependent.
- A clean preview with dirty apply state fails closed as ambiguous and dispatches nothing.
- Duplicate `exec.Succeeded` settlement is idempotent and does not re-emit `resource.Provisioned`.

Scope intentionally excludes periodic resync scheduling, drift detection, compensation/rollback,
driver-taxonomy routing, real Executor sandboxing, and real IaC adapter internals.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\resourceactor-reconcile-loop-contract test
```

Relevant design records:

- `docs/design/control-plane.md`: ResourceActor reconcile loop and resolution pipeline.
- `docs/design/adr/01-architecture-core.md`: ADR-0004 virtual actors and ADR-0006 per-resource stacks.
- `docs/design/platform-engineering.md`: provider/IaC platform boundary carried by PLAN-25.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Resourceactor Reconcile Loop Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
