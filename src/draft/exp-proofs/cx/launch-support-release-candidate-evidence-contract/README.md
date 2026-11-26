# Launch Support Release Candidate Evidence

Executable M3 proof for HOBO-474, proving V1 Launch Support Desk & Escalation release-candidate
evidence without building support tooling, publishing public support promises, or accessing customer
data.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\launch-support-release-candidate-evidence-contract test
```

## Proof Surface

- `launchSupportReleaseCandidateEvidence` records the M3 evidence set, owners, sources, blockers,
  accepted risks, release-cutline dependencies, missing GA evidence, follow-up issues, parent
  release-readiness sync, and scope boundaries.
- `validateLaunchSupportReleaseCandidateEvidence` fails closed on missing evidence, unowned
  blockers, underspecified accepted risks, weak release-cutline mappings, speculative follow-ups,
  unsynced parent readiness updates, support tooling scope creep, customer-data access,
  status-page publication, customer-facing SLA approval, and beta-to-GA support claims.
- `assertLaunchSupportReleaseCandidateEvidence` is the parser-style boundary: invalid records do
  not pass into downstream support, release, documentation, security, or operations consumers.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert the HOBO-474 M3 evidence records and owner/source/acceptance mappings. |
| Blockers and accepted risks are recorded. | Tests assert blockers and accepted risks are present and tied back to known evidence. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert support, operations, documentation, security, and release-cutline readiness domains use `v1-blocker.*` categories. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert the only follow-up points at missing GA support handoff evidence. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert status updates require a source when the gate requires parent sync. |

## Scope Guards

This proof deliberately does not implement support runtime services, helpdesk or ticket queues,
on-call scheduling, status-page publication, live customer support operations, production customer
data access, commercial support terms, customer-facing SLA commitments, or GA support readiness
claims.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the release-candidate support
  evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
