# Orchestrator Choreography Skeleton Contract

Independent POC for HOBO-73. It consumes a DeploymentPlan and models the M1
orchestrator boundary without implementing provider reconcile bodies, rollback,
drift resync, or incremental changed-node reconcile.

The contract proves:

- one ResourceActor view is created per DeploymentPlan resource;
- actor dependency subscriptions are expressed as `resource.Pending` with the
  dependency ids the actor waits on;
- root actors self-activate immediately;
- `resource.Provisioned` events unblock dependent actors edge-by-edge;
- independent roots share an activation wave;
- `deployment.Deployed` is emitted only after every resource is provisioned;
- duplicate `resource.Provisioned` events are idempotent;
- a stalled dependency leaves its dependents waiting while unrelated roots still
  provision;
- every emitted control-plane event carries the same `correlationId`.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\orchestrator-choreography-skeleton-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Orchestrator Choreography Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
