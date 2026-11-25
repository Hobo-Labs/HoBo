# Teardown & Recovery Scope Acceptance

Executable M0 proof for HOBO-444, defining Teardown & Recovery scope and acceptance before later
design or implementation work fans out.

The authoritative design record is
[`docs/design/teardown-recovery.md`](../../../../docs/design/teardown-recovery.md).

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\teardown-recovery-scope-acceptance test
```

## Proof Surface

- `TEARDOWN_RECOVERY_SCOPE` records goal, personas, scope in/out, non-goals, boundaries, teardown
  states, recovery modes, required evidence, dependencies, M1 evidence, and follow-up gate.
- `validateTeardownRecoveryScope` fails closed when M0 scope drifts into live provider deletes,
  provider mutation, production teardown runtime, restore runtime, billing, support tooling, or
  downstream issue creation.
- `classifyTeardownRecoveryDecision` routes adjacent decisions to their owning initiatives.
- `canCreateTeardownRecoveryFollowUp` blocks M1-M4 follow-up issues until M0 acceptance.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and five persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays are exported and validated for creep. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateTeardownRecoveryFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not build provider adapters, live deletes, production teardown
runners, restore services, backup/restore execution, upgrade rollback runners, support queues, SLA
automation, customer notifications, refunds, invoices, chargebacks, or customer-data recovery.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Teardown & Recovery Scope Acceptance.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
