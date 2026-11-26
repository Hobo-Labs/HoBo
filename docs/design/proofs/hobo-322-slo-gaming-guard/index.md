# HOBO-322 SLO Gaming Guard Proof

This proof connects [PLAN-05](../../reliability-observability-cost.md#plan-05),
[ADR-0045](../../adr/02-identity-security.md#adr-0045), and
[ADR-0078](../../adr/02-identity-security.md#adr-0078) to the executable draft package:

- [`src/draft/technical-proofs/slo-gaming-guard-contract`](../../../../src/draft/technical-proofs/slo-gaming-guard-contract)

## Scope

The package hardens SLO definitions and error-budget gate inputs against gaming. It consumes
SLO-as-code definitions, burn/gate context, and `AvailabilityView` estimate-vs-observed signals.
It does not implement the SLO computation engine, deploy gate, or AvailabilityView itself.

## Acceptance Coverage

| Requirement | Executable proof |
| --- | --- |
| Widening a window or relaxing an objective mid-burn is gated and audited. | `objective relaxation and window widening during burn require a policy gate and audit` |
| Secondary objective relaxation is not missed. | `secondary objective relaxation is gated and audited` |
| SLI source and exclusion rule changes are policy-visible and audited. | `SLI source and exclusion rule changes are policy visible and audited` |
| An SLI excluding too much served traffic is flagged. | `coverage check flags SLIs that exclude served failing traffic but accepts planned maintenance` |
| Estimated-vs-observed availability divergence raises a quality signal. | `architecture estimate versus observed availability gap raises a quality signal` |
| Every SLO definition change traces to a principal and justification. | `SLO definition changes without principal and justification are denied` |

## Adversarial Coverage

| Requirement | Executable proof |
| --- | --- |
| Iterative objective nudging just below a freeze threshold is detected. | `iterative objective nudging just below a freeze threshold is detected` |
| Legitimate maintenance exclusions are distinguished from error dropping. | `coverage check flags SLIs that exclude served failing traffic but accepts planned maintenance` |
| Backdated windows fail closed. | `backdated effective times fail closed` |
| Synthetic-only SLIs do not hide real-user failures. | `synthetic-only SLIs with real-user failures are flagged` |
| Relax-then-revert after deploy remains visible. | `relaxing an SLO and reverting after deploy lands remains visible as a gaming signal` |

## Evidence

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-gaming-guard-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff --check
```
