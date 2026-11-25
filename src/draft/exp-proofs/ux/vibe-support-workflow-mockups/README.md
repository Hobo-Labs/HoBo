# Vibe Support Workflow Mockups

Independent M1 proof for HOBO-550.

This package records support intake, severity triage, evidence linking, owner
routing, customer update, and closure mockup contracts. It proves the support
lead, support operator, customer admin, incident commander, release owner, and
security/compliance reviewer perspectives without building helpdesk software,
ticket automation, production support UI, customer-data access, incident
command, on-call staffing, or contractual SLA promises.

## Contract Boundaries

- In scope: mockup records, fixture examples, support intake states, persona
  questions, scenario paths, proof-mode labels, accessibility notes, and
  fail-closed scope guards.
- Quickstart dependency: support examples cite HOBO-577 quickstart fixture ids
  `rlq-deploy-run-accepted-v1`, `rlq-manage-stale-evidence-v1`,
  `rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1` without
  importing unmerged runtime behavior.
- Consumed but not owned: Support Workflow scope, Support SLA Channels, Launch
  Support Escalation, Incident Communications, Admin Console, Security
  Verification, Docs Portal, and Troubleshooting Guides records.
- Out of scope: live support services, helpdesk integrations, support queues,
  status-page publishing, incident command, customer-data access, production UI,
  launch claims without evidence, and public SLA language.

## Proof

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-support-workflow-mockups test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Mockups cover support lead, support operator, customer admin, incident commander, release owner, and security/compliance reviewer perspectives. | `mockups` map every persona to operating questions across received, classified, evidence-linked, owner-routed, customer-updated, and closed states. |
| Fixtures include requester, customer-safe summary, severity, affected surface, owner route, evidence links, redaction state, and next update condition. | `fixtures` carry each required support evidence field and `validateVibeSupportWorkflowMockups` rejects missing fields. |
| Target package and proof paths are pinned. | `parseVibeSupportWorkflowMockups` rejects path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover all required states and labels. |
| Scope out remains hard. | `classifySupportWorkflowMockupRequest` rejects helpdesk, ticket automation, customer data, incident command, on-call, production UI, contractual SLA, and proofless launch requests. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the mockup
  record. CUE uses the same lower-camel field names as the parsed TypeScript
  boundary.
- `architecture/pacts/` - Pact-style package boundary fixture that parses
  through `parseVibeSupportWorkflowMockups`.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
