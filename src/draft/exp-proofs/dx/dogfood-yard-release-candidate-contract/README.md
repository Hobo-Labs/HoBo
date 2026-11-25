# Dogfood Yard Release-Candidate Evidence Contract

HOBO-469 proof for the V1 Dogfood Yard & Hosted Operations M3 release-candidate evidence gate.

## What This Proves

- M3 release-candidate evidence is listed and mapped to owning projects.
- Blockers and accepted risks have owners, source evidence, mitigations, and launch-risk effects.
- Cross-project dependencies map into the v1 release cutline readiness domains.
- Follow-up execution work is allowed only for missing evidence.
- Parent initiative status update evidence is required if the gate changes launch risk.
- Scope guard rejects hosted-runtime work, live-provider proof, customer data, and GA claim creep.

## Scope Boundary

This proof does not build or operate a hosted Yard runtime, provision cloud resources, call provider
APIs, use live customer data, create support automation, or claim GA readiness. It records the M3
release-candidate evidence gate that later GA handoff work must consume.

## Verification

```powershell
pnpm --dir src\draft\exp-proofs\dogfood-yard-release-candidate-contract test
```

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the M3 evidence record.
- `architecture/pacts/` - PACT contract for the evidence boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
