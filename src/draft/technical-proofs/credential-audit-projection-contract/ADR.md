# Credential Audit Projection Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how CredentialAudit data is
parsed and how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted identity and token audit events are validated once at the boundary via
`validateIdentityEvent` from `identity-event-contract`. Parsed derived types
(`CredentialAuditView`, `PrincipalTimeline`, `GrantSummary`) are the only values
passed to projection folds and Gateway/MCP query surfaces.

## Event Architecture

- **Command** — append `identity.*` / `token.*` audit facts to the log.
- **Event** — broker grant/use/revoke facts remain append-only.
- **Actor** — principals (user, agent, service) appear in event `actor` and
  `subject` fields.
- **Event store** — compliance audit streams are never compacted (NFR-018).
- **Materialized view / projection** — `CredentialAuditView` folds grant/use/revoke
  chains and per-principal timelines.
- **Snapshot** — `snapshotCredentialAuditView` pins the read model at `seq`.
- **Read store** — Gateway and MCP query helpers read the snapshot, not raw streams.

No runtime engine is implemented here; this is a design-time contract that names
the projection boundary for S3-09 promotion into `packages/cloud/`.
