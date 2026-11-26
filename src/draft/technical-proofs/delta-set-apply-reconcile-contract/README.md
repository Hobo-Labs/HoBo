# Delta Set Apply Reconcile Contract

Independent POC for HOBO-103. It composes the earlier Deployment Set/Delta projection,
ResourceActor FSM, and Orchestrator choreography contracts into the M2 apply/reconcile boundary.

The contract proves:

- `delta.Applied` can produce a new immutable, content-addressed Deployment Set.
- Empty Deltas are explicit no-ops and do not mint a new Set or reconcile work.
- Incremental reconcile emits actions only for changed nodes.
- Removed resources destroy in dependency-safe order.
- Desired Sets with missing dependency references fail closed.
- Rollback re-applies a prior Set only after the external compat gate passes.
- Rollback past a completed contract boundary surfaces `compat.GateFailed` instead of silently applying.
- Environment-group promote emits `env.Promoted`, `env.PartiallyPromoted`, or `env.PromoteRolledBack` according to member outcomes and `optional` flags.

Scope intentionally excludes the Gatekeeper implementation, schema migration phases,
cross-Camp replication mechanics, real provider/IaC apply, drift repair, and the later
DeploymentView projection.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\delta-set-apply-reconcile-contract test
```

Relevant design records:

- `docs/design/platform-engineering.md`: Deployment Sets, Deltas, promote, rollback, and incremental deploy
- `docs/design/control-plane.md`: level-triggered ResourceActor reconciliation and Orchestrator choreography
- `docs/design/adr/01-architecture-core.md`: ADR-0003 event sourcing and ADR-0028 environment-group atomicity


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Delta Set Apply Reconcile Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
