# Domain Cutover Saga Contract

Independent proof for HOBO-148. It models the health-checked staged DNS
cutover layer that runs only after the Yard domain validation gate has emitted
`domain.Validated`.

## Contract Surface

- `runHealthCheckedCutover()` requires a validated domain change before any
  live record mutation.
- TTL lowering and waiting through the previous live TTL is a precondition
  before traffic shifts.
- Canary routing shifts a small weighted slice to the candidate record before a
  clean run widens to 100%.
- Health/SLO regression rolls back to the exact last-known-good live record and
  reports rollback RTO as at least the previous cached TTL.
- Hysteresis keeps flapping health from thrashing rollback.

## Proof Boundaries

This is a branch-local contract proof. It does not implement route-policy
selection, the DNS validation gate itself, concrete cloud DNS adapters, or the
Reliability health-signal source. Those are consumed through fixture inputs.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\domain-cutover-saga-contract test
```

The checks cover clean staged cutover, automatic rollback, TTL-precondition
refusal, validation-gate refusal, exact last-known-good rollback targeting, and
flapping-health hysteresis.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Domain Cutover Saga Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
