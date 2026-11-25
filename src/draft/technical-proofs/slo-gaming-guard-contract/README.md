# SLO gaming guard contract POC

This draft hardens the SLO-as-code and error-budget gate surface against Goodhart-style gaming.
It consumes existing SLO definitions, deploy-gate state, and `AvailabilityView` signals without
implementing the SLO computation engine, deploy gate, or AvailabilityView itself.

## Contract

- `assessSloDefinitionChange(...)` compares current/proposed SLO definitions, requires actor +
  justification audit data, audits all objective/source/window/exclusion changes, and sends
  objective relaxation, SLI source shifts during burn, window widening during burn, or exclusion-rule
  changes through a `can-deploy` policy gate.
- `evaluateSliCoverage(...)` checks served-vs-counted request coverage, distinguishes approved
  planned maintenance from suspicious error exclusions, and flags synthetic-only SLIs when real-user
  failures exist.
- `evaluateAvailabilityGap(...)` turns a large `AvailabilityView` estimate-vs-observed gap into a
  quality signal instead of treating the design-time estimate as a hard gate.

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

## Scope Boundary

The package does not compute SLO status, decide deployment promotion, or implement the
`AvailabilityView` projection. It only defines the hardening seam that consumes those existing
contracts and emits audit/policy/quality signals.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-gaming-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slo Gaming Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
