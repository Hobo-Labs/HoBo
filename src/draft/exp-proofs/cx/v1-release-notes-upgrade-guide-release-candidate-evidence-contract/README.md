# V1 Release Notes Upgrade Guide Release Candidate Evidence

Executable M3 proof for HOBO-473, proving V1 Release Notes & Upgrade Guide
release-candidate evidence without publishing final release notes, inventing compatibility or
upgrade guarantees, promising support responses, or promoting GA claims.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\v1-release-notes-upgrade-guide-release-candidate-evidence-contract test
```

## Proof Surface

- `releaseNotesReleaseCandidateEvidence` records the M3 evidence set, owners, sources, blockers,
  accepted risks, release-cutline dependencies, missing GA evidence, follow-up issues, parent
  release-readiness sync, and scope boundaries.
- `validateReleaseNotesReleaseCandidateEvidence` fails closed on missing evidence, unowned
  blockers, underspecified accepted risks, weak release-cutline mappings, speculative follow-ups,
  unsynced parent readiness updates, final release-note publication, unsupported compatibility or
  upgrade guarantees, support contact promises, and GA release-note claim promotion.
- `assertReleaseNotesReleaseCandidateEvidence` is the parser-style boundary: invalid records do
  not pass into downstream release, docs, bootstrap, compatibility, support, or cutline consumers.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert the HOBO-473 M3 evidence records and owner/source/acceptance mappings. |
| Blockers and accepted risks are recorded. | Tests assert blockers and accepted risks are present and tied back to known evidence. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert documentation, release-cutline, operations-readiness, support, and compatibility dependencies use `v1-blocker.*` categories. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert the only follow-up points at missing GA release-note handoff evidence. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert status updates require a source when the gate requires parent sync. |

## Scope Guards

This proof deliberately does not implement docs portal publication, release automation, customer
email, upgrade engine, compatibility harness, support workflow, runtime launch gates, final
release notes, customer-facing compatibility guarantees, zero-downtime upgrade promises, support
response-time promises, or GA release readiness claims.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the release-candidate release-note
  evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
