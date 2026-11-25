# Beta Pilot GA Handoff Evidence Contract

HOBO-477 proof for the V1 Beta Pilot & Feedback Loop M4 GA handoff evidence gate.

## What This Proves

- Required M4 evidence is listed and mapped to owning projects.
- Blockers and accepted risks have owners, source evidence, dispositions, and launch-risk effects.
- Cross-project dependencies map into v1 release cutline readiness domains.
- Follow-up execution work is allowed only for missing evidence.
- Parent release-readiness status update evidence is required because this gate reduces launch risk.
- Scope guards reject beta customer onboarding, feedback/support tooling, blocker resolution, and unsupported GA claim promotion.

## Scope Boundary

This proof does not onboard beta customers, expand the pilot cohort, implement a feedback portal,
create support tooling, resolve launch blockers, run hosted operations, or publish GA readiness
claims from beta evidence alone. It records the M4 handoff evidence boundary and the owner-reviewed
state required before beta feedback can support GA launch readiness.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cx\beta-pilot-ga-handoff-evidence-contract test
```

This draft workspace is also registered in `pnpm-lock.yaml` so frozen installs include the package
importer during local hooks and CI.

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the M4 evidence record.
- `architecture/pacts/` - PACT contract for the evidence boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
