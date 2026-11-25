# V1 Release Notes Upgrade Guide GA Handoff Evidence

Executable M4 proof for HOBO-480, proving V1 Release Notes & Upgrade Guide GA handoff evidence
without publishing final notes, implementing docs portal publication, sending customer
communications, inventing compatibility guarantees, promising zero-downtime upgrades, or approving
support SLAs.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\v1-release-notes-upgrade-guide-ga-handoff-evidence-contract test
```

## Proof Surface

- `releaseNotesGaHandoffEvidence` records the M4 evidence set, owner projects, blockers, accepted
  risks, release-cutline dependencies, no-missing-evidence follow-up boundary, parent
  release-readiness sync, and scope guards.
- `validateReleaseNotesGaHandoffEvidence` fails closed on malformed evidence, missing owner
  mappings, unknown blocker evidence, weak release-cutline categories, speculative follow-up issues,
  unsynced parent readiness updates, final release-note publication, docs portal/customer
  communication implementation, unsupported compatibility or upgrade guarantees, support promises,
  and unsupported public release-note claims.
- `parseReleaseNotesGaHandoffEvidence` returns the `ParsedReleaseNotesGaHandoffEvidence` parsed
  domain type. Invalid records do not pass into downstream release, docs, bootstrap,
  compatibility, support, migration, or cutline consumers.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert at least eight M4 release-note evidence records with owner/source/acceptance mappings. |
| Blockers and accepted risks are recorded. | Tests assert GA blockers and accepted risks are present and tied back to known evidence. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert documentation, release-cutline, operations-readiness, support, compatibility, and migration domains use `v1-blocker.*` categories. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert the GA gate has no missing evidence or speculative follow-ups and rejects follow-ups against accepted evidence. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert parent readiness sync and a source-backed update when launch risk changes. |

## Scope Guards

This proof deliberately does not publish final release notes, implement docs portal publication,
send customer emails, implement customer communication workflows, build upgrade or compatibility
harnesses, approve support SLAs, or make a GA release decision. It records GA handoff evidence and
leaves publication, launch decision, and customer communication mechanics to their owning projects.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the GA handoff evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ARCHITECTURE.md` - parse-don't-validate and event-architecture evidence.
