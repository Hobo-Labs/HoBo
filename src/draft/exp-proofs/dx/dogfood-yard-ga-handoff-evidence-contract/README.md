# Dogfood Yard GA Handoff Evidence Contract

Executable M4 proof for HOBO-476, proving V1 Dogfood Yard & Hosted Operations
GA handoff evidence without implementing Yard runtime, hosted operations,
support tooling, release automation, or public GA claims.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\dogfood-yard-ga-handoff-evidence-contract test
```

## Proof Surface

- `dogfoodYardGaHandoffEvidence` records the M4 evidence set, owners,
  predecessor gate states, blockers, accepted risks, release-cutline
  dependencies, follow-up boundaries, parent release-readiness sync, and public
  claim guards.
- `parseDogfoodYardGaHandoffEvidence` converts the raw evidence record into a
  parsed derived type before downstream consumers use it.
- `validateDogfoodYardGaHandoffEvidence` fails closed on malformed records,
  missing owner mappings, weak cutline categories, speculative follow-ups,
  unsynced parent readiness updates, Yard runtime implementation, live provider
  operations, live customer data, and unsupported GA or production recovery
  claims.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert eight M4 Dogfood Yard evidence records with owner/source/acceptance mappings. |
| Blockers and accepted risks are recorded. | Tests assert predecessor PRs and release-program handoff state are recorded as blockers or accepted risks. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert operations, release-cutline, support, documentation, reliability, bootstrap, and broker domains use release-blocker category prefixes. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert the only follow-up is existing HOBO-475 for missing release-program GA handoff evidence. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert parent readiness sync and a source-backed update when launch risk changes. |

## Scope Guards

This proof deliberately does not build Yard runtime, hosted operations runtime,
admin UI, bootstrap installer, support tooling, status-page publication, release
automation, provider operations, or customer-data handling. It records Dogfood
handoff evidence for release-owner review and keeps public GA readiness,
production recovery, SLA, and live hosted-operations claims out of scope.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the GA handoff
  evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
