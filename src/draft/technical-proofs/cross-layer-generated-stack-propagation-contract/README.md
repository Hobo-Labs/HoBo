# Cross-layer generated-stack propagation contract

Proof package for HOBO-371. It models the PLAN-23 generated-stack verification
path where one WIT domain-record change propagates through data, business,
message, intelligence, and UI layers using the same generate -> validate ->
repair -> certify -> persist loop.

## Scope

- In: one domain-record change, five layer artifacts, per-layer gates,
  region-scoped persistence decisions, propose/human-gate fallback, and
  generated-region drift detection.
- Out: production per-layer engines, real model providers, UI rendering,
  Firecracker, Registry storage, and live runtime mutation.

## What the proof asserts

- A `SupportTicket.priority` WIT record change regenerates and gates all five
  generated-stack layers.
- Deterministic layers persist as region-scoped reviewable diffs.
- Non-deterministic or unsafe layers degrade to a proposed diff requiring a
  human gate, without mutating source.
- `hobo codegen --check` style validation fails on hand-edited drift inside any
  layer's generated region and leaves the source unclobbered.

## Proof command

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-layer-generated-stack-propagation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cross Layer Generated Stack Propagation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
