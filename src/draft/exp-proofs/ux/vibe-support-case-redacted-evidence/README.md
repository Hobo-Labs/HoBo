# Vibe Support Case Redacted Evidence

Independent M2 proof for HOBO-564.

This package records a support case reference prototype with redacted evidence
packs. It consumes the accepted HOBO-550 support workflow mockups for intake,
triage, evidence linking, owner routing, customer updates, and closure without
building helpdesk software, support queues, customer-data access, incident
command, on-call staffing, production support UI, or contractual SLA promises.

## Contract Boundaries

- In scope: deterministic support case records, redacted evidence pack fields,
  incident/support references, admin context, docs source, proof package links,
  redaction states, next update conditions, proof-mode labels, scenario paths,
  accessibility notes, and fail-closed scope guards.
- Consumed but not owned: HOBO-550 support workflow mockups, Support Workflow,
  Support SLA Channels, Incident Communications, Launch Support Escalation,
  Security Verification, Docs, and the HOBO-577 quickstart fixtures cited by
  upstream support workflow evidence.
- Out of scope: live support services, helpdesk integrations, support queues,
  customer-data access, incident command, on-call staffing, production UI,
  commercial support terms, contractual SLA promises, and launch claims without
  evidence.

## Proof

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-support-case-redacted-evidence test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Prototype consumes M1 support intake, triage, owner-route, and customer update mockups. | `consumedSupportWorkflowMockupRefs` pins every accepted HOBO-550 mockup id and source proof path. |
| Evidence pack examples include redacted logs, incident/support references, admin context, docs source, proof package link, redaction state, and next update condition. | `evidencePacks` carry each required field and `parseVibeSupportCaseRedactedEvidence` rejects missing metadata. |
| Target package and proof paths match the issue. | Parser path checks reject package or proof path drift. |
| Happy, blocked, stale/unknown evidence, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each required path and label. |
| Scope out remains hard. | `classifySupportCasePrototypeRequest` rejects helpdesk, support queue, customer-data, incident-command, on-call, production UI, SLA, commercial support creep, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the support
  case record.
- `architecture/pacts/` - Pact-style package boundary fixture that parses
  through `parseVibeSupportCaseRedactedEvidence`.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
