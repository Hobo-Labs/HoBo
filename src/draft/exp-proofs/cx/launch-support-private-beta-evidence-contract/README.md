# Launch Support Private Beta Evidence

Executable M2 proof for HOBO-467, proving V1 Launch Support Desk & Escalation private beta
evidence without building support tooling, publishing public SLA promises, or accessing customer
data.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\launch-support-private-beta-evidence-contract test
```

## Proof Surface

- `launchSupportPrivateBetaEvidence` records the M2 evidence set, owners, sources, blockers,
  accepted risks, adjacent dependencies, missing evidence, follow-up issues, parent release-readiness
  sync, and scope boundaries.
- `validateLaunchSupportPrivateBetaEvidence` fails closed on pending evidence, speculative
  follow-ups, unsynced launch risk, public SLA promises, support runtime implementation, ticket
  queue implementation, status-page publication, customer-data access, and commercial terms approval.
- `assertLaunchSupportPrivateBetaEvidence` is the parser-style boundary: invalid records do not pass
  into downstream consumers.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert the six HOBO-467 evidence records and owner/source/proof fields. |
| Blockers and accepted risks are recorded. | Tests assert blockers and accepted risks are present and tied back to known evidence. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert support, release cutline, incident communications, release notes, and security dependencies cite accepted evidence. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert follow-ups point only at missing M3/M4 evidence records. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert launch-risk changes require parent status sync. |

## Scope Guards

This proof deliberately does not implement helpdesk software, support runtime services, support
ticket automation, status-page publication, support staffing, live customer support operations,
production customer-data access, commercial support terms, or customer-facing SLA commitments.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the private beta support evidence
  record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
