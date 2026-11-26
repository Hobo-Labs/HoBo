# HOBO-363 Dispatcher Maximize-Credits Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0071](../../adr/01-architecture-core.md#adr-0071).

The executable POC in
[`src/draft/technical-proofs/dispatcher-maximize-credits-contract`](../../../../src/draft/technical-proofs/dispatcher-maximize-credits-contract)
pins the M2 Dispatcher contract for `maximize-credits` placement and dispatch decisions.
HOBO-286 extends the same POC with reservation-CAS and recorded hysteresis proof.

## Acceptance Evidence

- A fixture `CreditLedgerView` ranks a CI job to the cheapest registered runner with free headroom
  and records `dispatch.Decided` with the pinned ledger seq, balance hash, and rationale.
- Replaying the serialized dispatch input yields the same winner, ranking, and event body.
- Exhausting a free tier rotates the next dispatch pick to the declared min-cost runner.
- Resource placement emits `match.Decided` with objective `maximize-credits`.
- Missing credit facts degrade to plain declared min-cost ranking.
- Budget caps and spend-to-date keep an otherwise cheaper over-cap runner behind an affordable
  runner.

## Adversarial Evidence

- A rate-limited free tier is not treated as depletable free headroom.
- Switching cost can beat free-tier chasing when egress/amortized move cost is larger than the
  savings.
- Equal zero-cost candidates prefer the soonest-expiring credit.
- Misdeclared free-tier facts degrade to min-cost instead of throwing or winning.
- No registered candidates fail closed without emitting `dispatch.Decided`.

## Scope Boundary

The HOBO-363 proof consumes local fixture `CreditLedgerView` snapshots and provider registrations.
Adapter calls, live cost-event production, traffic routing, and production dispatcher workers remain
out of scope; HOBO-286 adds the local reservation-CAS and hysteresis contract proof in the same
package.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dispatcher-maximize-credits-contract test
npm.cmd test
node scripts\validate-traceability.ts
```
