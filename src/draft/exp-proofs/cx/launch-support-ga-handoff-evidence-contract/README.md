# Launch Support GA Handoff Evidence Contract

Executable M4 proof for HOBO-481, proving V1 Launch Support Desk & Escalation
GA handoff evidence without implementing support tooling, status-page
publication, customer-data access, contractual SLA approval, or paid support
terms.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\launch-support-ga-handoff-evidence-contract test
```

## Proof Surface

- `launchSupportGaHandoffEvidence` records the M4 evidence set, owners,
  cleared blockers, accepted risks, release-cutline dependencies, follow-up
  boundaries, parent release-readiness sync, and scope guards.
- `validateLaunchSupportGaHandoffEvidence` fails closed on malformed evidence,
  missing owner mappings, unknown blocker evidence, weak release-cutline
  categories, speculative follow-up issues, unsynced parent readiness updates,
  support tooling, status-page publication, live customer-data access,
  customer-facing SLA approval, and unsupported public support claims.
- `parseLaunchSupportGaHandoffEvidence` returns an immutable branded record so
  downstream consumers accept parsed/refined evidence rather than raw DTOs.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert at least eight M4 support evidence records with owner/source/acceptance mappings. |
| Blockers and accepted risks are recorded. | Tests assert GA support blockers and accepted risks are present and tied back to known evidence. |
| Cross-project dependencies are reflected in the release cutline. | Tests assert support, operations-readiness, incident-communications, security, and release-cutline domains use `v1-blocker.*` categories. |
| Follow-up execution issues are created only where evidence is missing. | Tests assert the GA gate has no missing evidence or speculative follow-ups and rejects follow-ups against accepted evidence. |
| Parent HoBo v1 Release Readiness status updates if this gate changes launch risk. | Tests assert parent readiness sync and the Linear initiative status update `bb231636-fac5-43fa-b47e-f8cf08f242c0` when launch risk changes. |

## Scope Guards

This proof deliberately does not implement helpdesk software, support ticket
queues, support portal UI, on-call scheduling, status-page publishing, live
customer support operations, customer-data access, support impersonation,
contractual support SLAs, paid support tiers, commercial terms, or public
response-time guarantees.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the GA handoff
  evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
