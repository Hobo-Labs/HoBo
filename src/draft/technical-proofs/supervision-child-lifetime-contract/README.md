# Supervision Child Lifetime Contract

Independent proof for HOBO-519. It extends the DX SDK resilience semantics work
from `docs/design/dx-sdk-resilience-semantics.md` and composes with the
HOBO-516 `resilience-semantics-annex` instead of replacing it.

## Contract

- Invoked child work tied to parent state entry must stop or clean up when the
  parent exits or is cancelled.
- Spawned child work must carry an explicit stop or parent teardown ownership
  contract before the parent exits.
- Retry-budget exhaustion emits an escalation fact with child id, attempts, and
  operator context, and a process restart must not reset the exhausted budget.
- Cleanup traps emit audit facts and transfer safe teardown ownership instead of
  silently marking the parent successful.
- Replay-derived inspection reconstructs the supervision outcome from persisted
  facts without re-running child work.

## Scope Boundary

Included: event-fact fixtures for SDK-visible `workflow`, `step`, `actor`,
`saga`, and runbook-style supervision semantics.

Excluded:

- Distributed scheduler implementation.
- Production process supervision tree.
- New queue backend.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\supervision-child-lifetime-contract test
```

The adversarial fixtures fail with stable codes:

- `supervision.untracked_child_retry`
- `supervision.cleanup_not_audited`
- `supervision.retry_budget_reset`

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — Protobuf data shapes and CUE constraints for supervision
  facts, fixtures, case results, and reports.
- `architecture/pacts/` — PACT contract for the supervision conformance report
  boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
