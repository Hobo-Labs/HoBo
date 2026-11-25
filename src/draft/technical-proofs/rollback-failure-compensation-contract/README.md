# Rollback failure compensation contract POC

This draft pins the Harness behavior for rollbacks whose own compensation steps can fail. It
extends the delivery saga shape from HOBO-337 without implementing the happy-path rollout strategy
or the SLO gate.

## Contract

- `createRollbackCompensationEngine(...).compensate(...)` runs an ordered rollback plan with stable
  per-step idempotency keys and a bounded retry budget.
- Completed compensation steps are replayed from the event log and skipped on resume, so a restarted
  orchestrator completes only unfinished steps.
- A step that reports failure but exposes observed completed state is recorded as applied, preventing
  destructive duplicate compensation.
- Retry-budget exhaustion emits `rollout.NeedsHuman` with completed steps, incomplete steps,
  attempts, latest observed per-step results, and a blocking unsatisfied auto-revert obligation.
- Deadline expiry escalates from the persisted event log without needing another command attempt,
  so a flapping orchestrator cannot postpone human handoff indefinitely.
- Successful completion emits `rollout.RolledBack` and marks the auto-revert obligation satisfied.

## Scope Boundary

No SLO or metric-analysis gate is implemented here. No happy-path rollback strategy template,
stuck-rollout detector, real gateway adapter, flag store, paging integration, or human-resolution
workflow is implemented. This package only proves rollback-failure compensation, replay, escalation,
and obligation state.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\rollback-failure-compensation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Rollback Failure Compensation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
