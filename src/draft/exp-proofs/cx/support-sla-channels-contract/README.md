# Support SLA Channels Contract

Executable M0 proof for HOBO-496, defining Support Workflow SLA language, channel coverage,
severity routing, unsupported-request classes, and owner gates before later support implementation
or publication work fans out.

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\support-sla-channels-contract test
```

## Proof Surface

- `SUPPORT_SLA_CHANNELS_SCOPE` records goal, personas, scope in/out, non-goals, boundaries,
  channels, response targets, SLA language modes, unsupported request classes, escalation links,
  M1 evidence, and follow-up gate.
- `validateSupportSlaChannelsScope` fails closed when M0 scope drifts into contractual SLA
  approval, support tooling, ticket automation, or business-owner approval bypass.
- `canPublishContractualSla` blocks GA customer-facing SLA publication until both evidence and
  business-owner approval are present.
- `classifySupportRequest` routes adjacent or unsupported work to Business Owner / Legal, Admin
  Console, Incident Communications, V1 Release Program & Cutline, Backup & Restore, or Support
  Workflow.
- `canCreateSupportSlaFollowUp` blocks M1-M4 follow-up issues until M0 scope evidence is accepted.

## Architecture Guardrail Evidence

- PACT: `contracts/pacts/support-sla-channel-handoff.pact.json` fixes the Support Workflow consumer
  and support-SLA provider contract for accepted channel coverage and publication gates.
- Protobuf + CUE: `proto/support_sla_channels.proto` and `cue/support_sla_channels.cue` define the
  record shapes and constraints for channel records, response targets, and publication gates.
- Parse, don't validate: downstream M1 code must parse these records into derived domain types for
  channel id, severity id, SLA publication mode, and owner route before any workflow consumes them.
- Event architecture: the command `SupportSlaScopeCommand` is submitted by the launch owner actor,
  accepted as `SupportSlaScopeAccepted` or denied as `SupportSlaPublicationDenied` events, appended
  to the support event store, projected into materialized views for support docs, captured as
  snapshots at beta launch, and exposed through read stores for admin console and incident
  communication handoffs.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Support model defines channels, hours, response targets, severity routing, handoff rules, and unsupported request classes. | Tests assert channel, response target, handoff, and unsupported-class records. |
| SLA language distinguishes internal target, beta promise, and GA customer-facing commitment. | Tests assert the three SLA language modes and the GA business-owner approval gate. |
| Escalation links support, incident communications, admin console, and release cutline decisions. | Tests assert the escalation owner links and required boundary/source fields. |
| Scope out: no contractual SLA approval unless business owner signs off. | `canPublishContractualSla` and validation reject unapproved customer-facing SLA language. |

## Scope Guards

This proof deliberately does not build support tooling, ticket queues, helpdesk integrations,
incident automation, admin console UI, status-page publication workflows, legal terms, live support
operations, or production staffing schedules.
