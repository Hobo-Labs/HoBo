# HOBO-693 Inline budget authoring proof

This proof backs [Plan 21](../../authoring-resources-wiring.md#finops--inline-budget--cost-availability)
and [ADR-0039](../../adr/02-identity-security.md#adr-0039) §4
(`costAvailabilityProfile` inline authoring).

The executable POC in
[`src/draft/exp-proofs/dx/inline-budget-authoring`](../../../../src/draft/exp-proofs/dx/inline-budget-authoring/README.md)
proves REM-028 acceptance:

| Acceptance | Test evidence |
|---|---|
| Authoring catalog documents inline `budget` + `costAvailabilityProfile` | `normalizeCampPolicy accepts inline budget and costAvailabilityProfile declarations` |
| `hobo plan` surfaces projected cost, headroom, and tier preview | `surfacePlanBudget renders Cost & budget headroom for hobo plan human output` |
| Hard budget breach is visible at plan time (read-only would-deny) | `surfacePlanBudget annotates hard budget breach as would-deny without blocking read-only plan` |
| Profile without period cap fails closed | `costAvailabilityProfile without hard budget fails closed at normalize` |

Scope boundary: contract adapter over mocked policy/metering seams. Production
`hobo plan` CLI wiring and policy-engine enforcement remain downstream.
