# Launch Support Dogfood/Alpha Evidence

Executable M1 proof for HOBO-460, proving V1 Launch Support Desk & Escalation dogfood/alpha
evidence without building support tooling or publishing customer-facing SLA promises.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\launch-support-dogfood-alpha-evidence test
```

## Proof Surface

- `launchSupportDogfoodAlphaEvidence` records the M1 evidence set, owners, sources, findings,
  adjacent dependencies, and scope boundaries.
- `validateLaunchSupportDogfoodAlphaEvidence` fails closed on missing evidence owners, support
  tooling implementation creep, and unapproved customer-facing SLA claims.
- `deriveSupportFollowUpIssues` creates follow-up issue records only for missing evidence.
- `buildParentInitiativeStatus` updates the parent release-readiness initiative only when launch
  blockers change support launch risk.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert the six HOBO-460 evidence records and owner/source/proof fields. |
| Blockers and accepted risks are recorded. | Tests assert accepted-risk, launch-note, and post-GA follow-up findings. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert dependencies on Cutline, Incident Communications, Support Workflow, Beta Pilot, Reliability, and Operators/SRE. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert one non-blocking follow-up for the alpha known-limitation FAQ gap. |
| Parent HoBo v1 Release Readiness status updates only if launch risk changes. | Tests assert `onTrack` for accepted evidence and `atRisk` when a launch blocker is added. |

## Scope Guards

This proof deliberately does not implement helpdesk software, support ticket automation, status-page
publication, support staffing, live customer support operations, production customer-data access, or
customer-facing SLA commitments.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the support evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
