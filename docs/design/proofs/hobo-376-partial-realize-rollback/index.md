# HOBO-376 Partial Realize Rollback Proof

This executable proof backs [PLAN-04](../../control-plane.md#plan-04),
[ADR-0004](../../adr/01-architecture-core.md#adr-0004), and
[ADR-0006](../../adr/01-architecture-core.md#adr-0006).

## Proof Surface

- [Draft package](../../../../src/draft/technical-proofs/partial-realize-rollback-contract/README.md)
- [Executable checks](../../../../src/draft/technical-proofs/partial-realize-rollback-contract/test/partial-realize-rollback.test.ts)

## Proven Constraints

- Created-but-not-in-state provider objects are swept by tag during rollback instead of duplicated.
- Recorded-state siblings in the same deployment are destroyed while other deployments are left
  untouched.
- Ambiguous Executor output is reconciled by adopting the tagged live object before retry, preserving
  exactly-once create.
- Destroy failures reach `resource.CompensationFailed` and emit incident escalation signals.
- Replay after `deployment.RolledBack` re-derives desired `Destroyed` state and finishes cleanup.
- Repeated rollback attempts are idempotent.

## Scope Boundary

The proof stays at the contract POC layer. It does not implement real Pulumi/OpenTofu providers,
ResourceActor runtime integration, the base compensation path, or SRE incident processing.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\partial-realize-rollback-contract test
```
