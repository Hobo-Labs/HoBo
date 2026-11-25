# Dogfood Yard Private Beta Evidence Contract

Executable M2 proof for HOBO-462, recording the private beta evidence gate for V1 Dogfood Yard &
Hosted Operations without building hosted Yard runtime, admin UI, provider adapters, support
automation, or bootstrap installer runtime.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\dogfood-yard-private-beta-evidence-contract test
```

## Proof Surface

- `DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE` records required evidence, scenario fixtures, evidence
  channels, blockers, accepted risks, cross-project dependencies, follow-up issue boundaries, and
  parent release-readiness sync.
- `validateDogfoodPrivateBetaEvidence` fails closed when required evidence is pending, follow-ups
  are speculative, launch-risk sync is missing, scenarios use live customer data, live provider work
  appears, or any private/public/unsupported claim boundary promotes private beta proof to production
  readiness.
- `summarizePrivateBetaEvidence` emits release-cutline, support, and beta-readiness entries.
- `classifyDogfoodPrivateBetaWork` routes adjacent runtime, admin UI, provider, and support
  implementation to owning projects instead of expanding HOBO-462.

## Architecture Guardrail Evidence

- PACT: `architecture/pacts/dogfood_yard_private_beta_evidence_contract.pact.json` fixes the M2
  boundary between Dogfood Yard private beta evidence and release/support consumers.
- Protobuf + CUE: `architecture/dogfood_yard_private_beta_evidence_contract.proto` and
  `architecture/dogfood_yard_private_beta_evidence_contract.cue` define evidence, scenario,
  channel, blocker, risk, dependency, follow-up, and parent-sync records.
- Parse, don't validate: downstream M2 code must parse these records into derived domain types for
  scenario id, evidence channel id, owner, status, blocker, accepted risk, dependency, missing
  evidence, and follow-up issue before using them.
- Event architecture: `DogfoodPrivateBetaEvidenceCommand` is submitted by the Dogfood readiness
  actor, accepted as `DogfoodPrivateBetaEvidenceAccepted` or denied as
  `DogfoodPrivateBetaEvidenceDenied`, appended to the release-readiness event store, projected into
  release-cutline/support/beta-readiness views, captured as a private beta snapshot, and read
  through release/support stores.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert all required evidence has owner, source, proof statement, and accepted status. |
| Blockers and accepted risks are recorded. | Tests assert blockers and accepted risks exist, cite known evidence, and carry owner/disposition/mitigation data. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert summary cutline entries and dependency mappings for release notes, support, bootstrap, reliability, and broker work. |
| Follow-up execution issues are created only where evidence is missing. | Tests reject follow-ups tied to accepted evidence; only HOBO-469 and HOBO-476 cover missing M3/M4 evidence. |
| Parent HoBo v1 Release Readiness status is updated if this gate changes launch risk. | Tests reject changed launch risk without status update; the accepted M2 record carries no launch-risk change. |

## Scope Guards

This proof deliberately does not build hosted Yard runtime, admin UI, support ticket automation,
provider adapters, bootstrap installer runtime, live cloud provisioning, production provider calls,
customer-data debugging, provider credential storage, release-candidate evidence, GA handoff
evidence, or public support readiness claims.
