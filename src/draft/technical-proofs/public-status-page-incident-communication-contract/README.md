# Public Status Page Incident Communication Contract

Independent POC for HOBO-497. It pins the public status-page and incident
communication contract without implementing live status-page publishing, support
tooling, subscriber management, notification delivery, runbook execution, or
customer-facing SLA promises.

## Contract Surface

- `PUBLIC_STATUS_PAGE_CONTRACT` is the deterministic M0 record.
- Status-page scope covers public components, active incidents, planned
  maintenance, history, and subscription handoff expectations.
- Component taxonomy covers control-plane API, deployments, identity/auth,
  runtime Camps, and docs/support.
- Incident and maintenance states carry customer-safe meanings and required
  evidence.
- Internal and external-candidate triggers stay separated by a publication gate.
- Customer templates require incident IDs, redaction gates, evidence sources, and
  next-update conditions.
- Unsupported status dimensions document private debug data, raw provider
  topology, unverified root cause, contractual response SLAs, and
  customer-specific data.

## Scope Boundaries

Included:

- Deterministic status-page contract fixture and validator.
- Customer-safe incident and maintenance templates.
- Follow-up gate for downstream status-page implementation issues.
- Scope guards for live publishing, unapproved SLA promises, and customer-data
  leakage.

Excluded:

- Live status-page publishing, subscriber management, notification dispatch, or
  support ticket automation.
- Contractual SLA approval or public response-time commitments.
- Private tenant/debug data, raw provider topology, or speculative root cause.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\public-status-page-incident-communication-contract test
```
