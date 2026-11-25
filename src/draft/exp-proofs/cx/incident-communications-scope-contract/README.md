# Incident Communications Scope Contract

Executable M0 proof for HOBO-450.

This package records the accepted productization boundary for Incident Communications before M1
design or implementation issues can depend on it. It proves the user/business goal, primary
personas, scope-in, scope-out, non-goals, service/UX/security/support boundaries, authoritative
dependencies, communication surfaces, incident states, template kinds, M1 evidence, and follow-up
gate.

The durable design record lives in
[`docs/design/incident-communications.md`](../../../../../docs/design/incident-communications.md). Branch
evidence is summarized in
[`docs/design/proofs/hobo-450-incident-communications`](../../../../../docs/design/proofs/hobo-450-incident-communications/README.md).

## Contract Surface

- `INCIDENT_COMMUNICATIONS_SCOPE` defines the accepted M0 scope record.
- `validateIncidentCommunicationsScope(scope)` checks required acceptance and adversarial
  boundaries.
- `canCreateIncidentCommunicationFollowUp({ phase, m0Accepted })` blocks M1-M4 follow-up work until
  M0 acceptance is recorded.
- `canPublishIncidentCommunication(...)` blocks customer-visible updates without evidence,
  redaction approval, and customer-data/SLA exclusion.
- `classifyIncidentCommunicationRequest(request)` routes adjacent work to owning lanes instead of
  expanding HOBO-450.

## Negative Coverage

Validation rejects scope creep into live notification dispatch, status-page publishing
implementation, ticket automation, runbook execution, contractual SLA promises, and customer-data
fields. Publication gates reject customer-visible communication when incident evidence is missing,
redaction is not approved, customer data is present, or contractual SLA language is included.

## Verification

```powershell
pnpm --prefix src\draft\exp-proofs\cx\incident-communications-scope-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Incident Communications scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
