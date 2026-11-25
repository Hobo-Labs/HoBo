# Launch Site Demo Alpha Evidence Contract

HOBO-458 proof for the V1 Launch Site, Messaging & Demo Assets M1 dogfood/alpha evidence gate.

## What This Proves

- M1 dogfood/alpha evidence is listed and mapped to owner projects.
- Blockers and accepted risks have owners, mitigations, and launch-risk effects.
- Cross-project dependencies map into the v1 release cutline readiness domains.
- Follow-up execution work is allowed only for missing evidence.
- Parent initiative status update evidence is required if the gate changes launch risk.
- Scope guard rejects launch-site implementation and unsupported public claims.

## Scope Boundary

This proof does not build or publish a launch site, write final marketing copy, create final demo
assets, provision live infrastructure, or claim production readiness. It records the alpha evidence
gate that future launch-site and demo-asset work must consume.

## Verification

```powershell
pnpm --dir src\draft\exp-proofs\cx\launch-site-demo-alpha-evidence-contract test
```

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the M1 evidence record.
- `architecture/pacts/` - PACT contract for the evidence boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
