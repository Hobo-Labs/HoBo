# HOBO-300 AvailabilityView Proof

This proof covers the M2 reliability slice for ADR-0078 architecture-derived
availability.

## Scope

- `src/draft/technical-proofs/availability-view-contract` computes an `AvailabilityView` as a
  pure projection over a dependency graph plus declared SLAs.
- Serial dependencies multiply availability, redundant sets compose in
  parallel, and shared failure domains bound redundancy gains.
- Observed availability is shown beside the estimate, and estimate-vs-observed
  gaps become explicit warnings.
- `availabilitySlo` floor failures produce warn-only `can-deploy` feedback, not
  hard deploy denial.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Serial 3-provider chain yields fewer nines than any single provider. | `serial provider chain estimates fewer nines than any single provider` |
| Redundant pair yields more nines than either member. | `redundant pair composes parallel availability above either member` |
| Estimate renders next to observed number. | `serial provider chain estimates fewer nines than any single provider` |
| Architecture below `availabilitySlo` warns at `can-deploy`. | `availabilitySlo floor emits a can-deploy warning, not a hard deny` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Provider has no declared SLA. | `unrated provider uses conservative default and surfaces evidence` |
| Dependency graph has a cycle. | `cycles fail closed instead of emitting an optimistic estimate` |
| Shared dependency is double-counted across graph paths. | `shared dependency in separate graph paths is counted once` |
| Redundant set hides one failure domain. | `shared dependency in redundant paths is counted once and flagged` |
| Estimate diverges wildly from observed availability. | `estimate versus observed divergence is surfaced, not hidden` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\availability-view-contract test
```
