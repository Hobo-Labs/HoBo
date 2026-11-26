# Public Status Page & Incident Communication — Architecture Evidence (HOBO-497, M0)

This note records the architecture evidence required by the repository
guardrails for the M0 contract. It is design evidence only: no live status
page, transport, persistence, or notification delivery is implemented here.

## Schema sources of truth

- **Protobuf** — `proto/public_status_page.proto` defines the data shapes and
  records exchanged across the status/incident boundary (`StatusPageComponent`,
  `IncidentOpened`, `IncidentUpdated`, `IncidentResolved`,
  `MaintenanceScheduled`) and the `IncidentState` enum.
- **CUE** — `cue/public_status_page.cue` constrains every protobuf type with the
  customer-safe value rules (id shapes, non-empty fields, allowed states).
- **PACT** — `contracts/pacts/status-page-projection.pact.json` is the
  executable contract for the projection boundary between the public status page
  read model and the incident-communication event store.

## Parse, don't validate

Inbound incident and maintenance payloads are not re-validated ad hoc at every
call site. They are parsed once at the boundary into **derived domain types**
whose existence proves the customer-safe invariants already hold:

- A raw incident message is parsed into a `ParsedIncidentUpdate` derived type
  only after the CUE constraints and the redaction gate pass; downstream code
  accepts the parsed type and never the raw payload.
- A raw maintenance request is parsed into a `ParsedMaintenanceWindow` derived
  type carrying an approved, customer-safe window. Code that cannot produce the
  parsed type cannot publish.

Following parse, don't validate, the parsed/derived types are the only shapes
the projection consumes, so an unredacted or malformed record is unrepresentable
past the boundary rather than defended against repeatedly.

## Event architecture

The contract is modeled as an event-sourced, CQRS-style boundary:

- **Command** — `PublishIncidentUpdate` and `ScheduleMaintenance` are the
  commands an incident commander issues; each command is gated by the
  publication and redaction rules in the contract.
- **Events** — accepted commands emit immutable events (`IncidentOpened`,
  `IncidentUpdated`, `IncidentResolved`, `MaintenanceScheduled`).
- **Actor** — the incident-commander actor owns command handling and is the
  single writer for an incident stream; the support-lead actor owns redaction
  approval for externally sourced triggers.
- **Event store** — events are appended to the incident-communication event
  store, the append-only system of record for the incident timeline.
- **Materialized view / projection** — the public status page is a projection
  (a materialized view) built by folding events into customer-safe component
  status and incident/maintenance history.
- **Snapshot** — periodic snapshots of the projection bound replay cost so the
  status page can be rebuilt without replaying the full event store.
- **Read store** — the public status page is served from a read store populated
  by the projection; the read store holds only customer-safe, redacted fields
  and never raw responder or tenant data.

All of the above is M0 design evidence; implementation of the live publish flow,
subscriber management, and notification delivery remains gated behind M0
acceptance per the follow-up gate in the contract.
