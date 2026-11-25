# Beta Pilot Release Candidate Evidence Contract

HOBO-470 proof for the V1 Beta Pilot & Feedback Loop M3 release-candidate evidence gate.

## What This Proves

- M3 release-candidate evidence is listed and mapped to owner projects.
- Blockers and accepted risks have owners, dispositions, and launch-risk effects.
- Cross-project dependencies map into the v1 release cutline readiness domains.
- Follow-up execution work is allowed only for missing evidence.
- Parent release-readiness status update evidence is required when this gate changes launch risk.
- Scope guards reject beta customer onboarding and beta-to-GA claim promotion.

## Scope Boundary

This proof does not onboard beta customers, build feedback tooling, publish support SLAs, implement
product UX, or claim GA readiness. It records the release-candidate evidence gate that the later
GA handoff issue must consume.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cx\beta-pilot-release-candidate-evidence-contract test
```

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the M3 evidence record.
- `architecture/pacts/` - PACT contract for the evidence boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
