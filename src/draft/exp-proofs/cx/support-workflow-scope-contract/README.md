# Support Workflow Scope Contract

Executable M0 proof for HOBO-448, defining Support Workflow scope and acceptance before later
support tooling, helpdesk, or live support operations work fans out.

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\support-workflow-scope-contract test
```

## Proof Surface

- `SUPPORT_WORKFLOW_SCOPE` records goal, personas, scope in/out, non-goals, boundaries, intake
  states, required evidence, dependencies, M1 evidence, and the follow-up gate.
- `validateSupportWorkflowScope` fails closed when M0 scope drifts into helpdesk automation,
  production customer-data access, unapproved SLA promises, or incident-command ownership.
- `classifySupportWorkflowDecision` routes adjacent work to Support Tooling, Incident
  Communications, Admin Console, Business Owner / Legal, Security Verification, or Support
  Workflow.
- `canCreateSupportWorkflowFollowUp` blocks M1-M4 follow-up issues until M0 evidence is accepted.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | Tests assert `goal` and six persona records. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are exported and validated for creep. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateSupportWorkflowFollowUp` blocks implementation phases until accepted. |

## Scope Guards

This proof deliberately does not build helpdesk software, ticket queue automation, support portal
UI, status-page publishing, live support staffing, production customer-data access, incident
command, on-call scheduling, runbook execution, or contractual SLA language.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Support Workflow scope.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
