# V1 Outcome Activation Rail Contract

HOBO-508 proof for the v1 outcome activation rail M0 scope and acceptance.

## What This Proves

- The rail carries a user from outcome capture through safe proof, plan review, guarded launch, and
  value proof.
- Every stage names entry criteria, exit criteria, persona labels, evidence objects, and owning
  handoff projects.
- Required proof surfaces are mapped to existing capabilities: onboarding, plan/diff, deployment
  status/topology, safe tests, cost/approval gates, telemetry, support, and docs.
- Non-expert buyer/user visibility is separated from technical operator visibility.
- The rail is only a UX orchestration layer over existing surfaces; it does not build a workflow
  engine or duplicate product shell.
- Follow-up M1-M4 implementation work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 activation-rail record. It does not implement product UI, runtime
workflow orchestration, deployment execution, telemetry collection, support tooling, or downstream
implementation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\v1-outcome-activation-rail-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for V1 Outcome Activation Rail Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
