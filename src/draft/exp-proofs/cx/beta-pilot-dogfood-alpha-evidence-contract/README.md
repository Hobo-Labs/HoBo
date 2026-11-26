# Beta Pilot Dogfood/Alpha Evidence Contract

HOBO-456 proves the M1 dogfood/alpha evidence gate for the V1 Beta Pilot &
Feedback Loop project.

## What This Proves

- The M1 gate consumes the HOBO-404 beta feedback M0 contract.
- Required dogfood/alpha evidence is listed and mapped to owner projects.
- Blockers and accepted risks route through cutline, support, product UX, docs,
  or capability owners.
- Follow-up issue creation is limited to missing accepted evidence, owner
  blockers, or scope changes.
- Parent initiative status updates are required only when launch risk changes.

## Boundary

This package records the M1 evidence contract. It does not onboard beta
customers, build a feedback portal, resolve surfaced blockers, or mutate parent
release status when the evidence gate records no launch-risk delta.

## Verification

```powershell
pnpm --dir src\draft\exp-proofs\cx\beta-pilot-dogfood-alpha-evidence-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for the evidence
  gate contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ARCHITECTURE.md` — parse-don't-validate and event-architecture evidence.
