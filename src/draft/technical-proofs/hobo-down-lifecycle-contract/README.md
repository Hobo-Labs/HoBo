# HoBo Down Lifecycle Contract

Independent POC for HOBO-132. It pins the `hobo down [--camp]` lifecycle seam over a replayable
event log without implementing the production `hobo up` convergence engine, compensation engine, IaC
adapters, or policy engine internals.

The contract proves:

- `hobo down --camp <id>` computes reverse dependency teardown order from the deployment topology.
- Destroy progress is proven by `deployment.DownStarted`, `resource.DestroyRequested`,
  `resource.Destroyed`, `resource.DestroyFailed`, `deployment.DownCompleted`, and
  `deployment.DownNoop` events.
- Re-running `down` after successful teardown is an idempotent no-op and does not call providers.
- Production-typed Camps require explicit confirmation or approval before any destroy request.
- Partial teardown reports `partial`, names remaining resources, and resumes from the event log.
- Live resources in other Camps that still depend on a target resource block teardown before any
  provider call.
- Unknown Camps fail clearly, and empty Camps succeed as a no-op.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-down-lifecycle-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Down Lifecycle Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
