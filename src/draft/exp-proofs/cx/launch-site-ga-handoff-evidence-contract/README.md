# Launch Site GA Handoff Evidence Contract

HOBO-479 proof for the V1 Launch Site, Messaging & Demo Assets M4 GA handoff evidence gate.

## What This Proves

- M4 GA handoff evidence is listed and mapped to owner projects.
- Blockers and accepted risks have owners, dispositions, and launch-risk effects.
- Cross-project dependencies map into v1 release cutline readiness domains.
- Follow-up execution work is allowed only for missing evidence.
- Parent release-readiness status update evidence is required when this gate changes launch risk.
- Scope guards reject public launch-site build work, final copy/assets, real cloud provisioning, and unsupported GA production-readiness claims.

## Scope Boundary

This proof does not build or publish the launch site, write final launch copy, create final visual
assets, record final demo video, provision real cloud resources, handle provider credentials, or
claim production readiness from release-candidate or private-beta evidence. It records the GA
handoff evidence boundary and the owner review required before public wording can move from draft
or hold to publication.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cx\launch-site-ga-handoff-evidence-contract test
```

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the M4 evidence record.
- `architecture/pacts/` - PACT contract for the evidence boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
