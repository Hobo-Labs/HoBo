# HOBO-68 ResourceActor FSM Contract POC

This draft pins the M1 ResourceActor skeleton from HOBO-68:

- actor keys use `resource:<deployment>:<name>`
- the documented FSM emits `resource.*` lifecycle facts
- actors hydrate from their own resource event stream after a crash
- ActorHost lease fencing prevents two concurrent writers for one resource
- late duplicate events are idempotent no-ops
- `reconcile()` stops at an executor-dispatch intent instead of applying infrastructure

Scope intentionally stops before the idempotent preview/apply loop body, executor dispatch
internals, compensation orchestration across a DAG, drift detection, and ActorHost persistence.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\resourceactor-fsm-contract test
```

Relevant design records:

- `docs/design/control-plane.md`: ResourceActor reconciliation FSM, ActorHost lease, choreography
- `docs/design/architecture.md`: Orchestrator responsibilities and deploy command path
- `docs/design/adr/01-architecture-core.md`: ADR-0004 choreography sagas + virtual actors


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Resourceactor Fsm Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
