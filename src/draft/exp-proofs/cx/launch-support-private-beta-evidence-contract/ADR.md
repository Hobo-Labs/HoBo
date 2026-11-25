# Launch Support Private Beta Evidence — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline through
`assertLaunchSupportPrivateBetaEvidence`: raw evidence records cross one boundary and become
derived domain types for the accepted private-beta evidence snapshot, blocker records, accepted-risk
records, dependency records, follow-up records, and scope-boundary records, or fail closed.
Downstream release, support, security, and documentation consumers receive those parsed types rather
than re-checking broad DTOs.

## Event Architecture

The accepted record is the read model behind a small event flow:

- **Command** — record private-beta support evidence for HOBO-467.
- **Event** — `support.privateBetaEvidenceAccepted` or a rejected evidence-change event appends to
  the log.
- **Actor** — the Launch Support readiness actor owns support evidence changes for this project.
- **Event store** — accepted evidence events are appended to the platform event store as the durable
  source of truth.
- **Materialized view / projection** — the V1 Release Readiness projection folds support evidence
  into blocker, accepted-risk, limitation, and follow-up state.
- **Snapshot** — `launchSupportPrivateBetaEvidence` is the package's deterministic projection
  snapshot.
- **Read store** — release notes, incident communications, and support workflow query that read
  store rather than raw events.

No runtime engine, projector, event store, helpdesk, or support service is implemented here; this is
a design-time contract that names the command, event, actor, projection, and read-store boundaries
so later implementation inherits a consistent vocabulary.
