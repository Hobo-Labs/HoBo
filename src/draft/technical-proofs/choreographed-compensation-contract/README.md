# HOBO-109 Choreographed Compensation Contract

This draft POC pins the M2 rollback contract from HOBO-109:

- `resource.Failed` past the no-go threshold emits one `deployment.RolledBack`.
- `deployment.RolledBack` flips already-provisioned resources' desired state to `Destroyed`.
- Compensation destroys provisioned resources in reverse dependency order.
- A resource will not destroy while any provisioned dependent still exists.
- Replay after a crash re-derives the rollback from events instead of relying on a one-shot command.
- Destroy failure reaches `resource.CompensationFailed` and emits `incident.EscalationRequested`.

Adversarial coverage:

- crash immediately after `deployment.RolledBack`;
- dependent that never reaches `Destroyed`;
- racing failures that could otherwise emit duplicate rollback;
- failure before a resource was ever provisioned.

Scope intentionally stops before orphan sweep / created-but-not-in-state handling, provider destroy adapters, incident handling, and drift-driven destroy. Those remain owned by separate slices.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\choreographed-compensation-contract test
```

Relevant design records:

- `docs/design/control-plane.md`: choreography compensation in Plan 04
- `docs/design/adr/01-architecture-core.md`: ADR-0004
- `docs/implementation-plan.md`: HOBO-109 wiring under Control Plane


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Choreographed Compensation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
