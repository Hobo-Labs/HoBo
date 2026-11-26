# Launch Site Release Candidate Evidence Contract

HOBO-472 proof for the V1 Launch Site, Messaging & Demo Assets M3 release-candidate evidence gate.

## What This Proves

- M3 release-candidate launch-site evidence is listed and mapped to owner projects.
- Blockers and accepted risks have owners, dispositions, and launch-risk effects.
- Cross-project dependencies map into the v1 release cutline readiness domains.
- Follow-up execution work is allowed only for missing evidence.
- Parent release-readiness status update evidence is required when this gate changes launch risk.
- Scope guards reject launch-site implementation, final public copy, and unsupported GA claims.

## Scope Boundary

This proof does not build a launch site, publish final public copy, create final visual assets,
record live hosted demos, or claim GA readiness. It records the release-candidate evidence gate that
the later GA handoff issue must consume.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cx\launch-site-release-candidate-evidence-contract test
```

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the M3 evidence record.
- `architecture/pacts/` - PACT contract for the evidence boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
