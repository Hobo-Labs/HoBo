# HOBO-109 Choreographed Compensation Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0004](../../adr/01-architecture-core.md#adr-0004).

## Proof Surface

- [Draft package](../../../../src/draft/technical-proofs/choreographed-compensation-contract/README.md)
- [Executable checks](../../../../src/draft/technical-proofs/choreographed-compensation-contract/test/choreographed-compensation.test.ts)

## Proven Constraints

- A no-go `resource.Failed` emits one `deployment.RolledBack`, even when failures race.
- Already-provisioned resources re-derive desired `Destroyed` state from rollback replay.
- Provisioned resources are destroyed in reverse dependency order.
- Dependencies are blocked while a dependent still exists, and the block is surfaced.
- Failed destroy reaches `resource.CompensationFailed` and emits an incident escalation signal.
- A resource that failed before it was ever provisioned is not compensated.

## Scope Boundary

The proof intentionally stops at a contract POC. It does not implement provider destroy adapters,
orphan sweep / created-but-not-in-state handling, incident/SRE handling, drift-driven destroy, or a
production ResourceActor runtime.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\choreographed-compensation-contract test
```
