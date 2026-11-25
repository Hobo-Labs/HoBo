# HOBO-277 SLO Computation Engine Proof

This proof covers the M2 reliability slice that consumes the HOBO-111
SLO-as-code contract and ADR-0045's SLO/error-budget decision.

## Scope

- `src/draft/technical-proofs/slo-computation-engine-contract` defines a pure computation
  boundary over an `SLISource` port.
- The engine evaluates SLI ratio samples over the objective window and over the
  configured burn-rate threshold windows.
- The output is a queryable status view with remaining budget, consumed budget,
  window-level burn rates, violated thresholds, and a `slo.BudgetBurned` event
  adapter using the existing SLO event envelope.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Fixture SLI breaching objective produces correct remaining budget and burn rate. | `fixture SLI breaching objective computes remaining budget and burn rate` |
| Multi-window logic fires fast on severe burn and slow on gradual burn. | `multi-window burn-rate fires fast for severe burn and slow for gradual burn` |
| `slo.BudgetBurned` emitted with right magnitude. | `slo.BudgetBurned event carries computed burn rate and remaining budget magnitude` |
| Healthy SLI does not burn. | `healthy SLI does not burn budget or emit a BudgetBurned event` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Gap in SLI series must not mean healthy. | `gap in SLI series fails closed instead of treating no data as 100 percent healthy` |
| Burst burns whole budget inside one window. | `burst can burn the whole budget inside one fast window` |
| Window-boundary double counting. | `window boundaries are half-open to avoid double counting adjacent windows` |
| Stale SLI source value. | `stale SLI source values fail closed with a freshness reason` |
| Division by zero on zero traffic. | `zero traffic fails closed without dividing by zero` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-computation-engine-contract test
```
