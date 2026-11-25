# CredentialAudit Projection Contract POC

Independent POC for HOBO-635. Pins the M1 `CredentialAudit` projection from
[Plan 05](../../../docs/design/reliability-observability-cost.md#plan-05) and
the NFR-018 / TR-052 never-compacted audit retention floor from
[ADR-0023](../../../docs/design/adr/02-identity-security.md#adr-0023) without
implementing production `packages/cloud/` wiring, SIEM export, or live Gateway/MCP
servers.

## Contract Surface

- `snapshotCredentialAuditView(events, { seq })` folds `identity.*` and `token.*`
  streams into a `CredentialAuditView` with grant/use/revoke chains and per-principal
  timelines.
- `applyCredentialAuditEvent(view, event)` proves incremental fold equivalence.
- `queryCredentialAuditViaGateway(view, query)` answers security-review queries by
  principal or grant id.
- `queryCredentialAuditViaMcp(view, tool, args)` exposes `inspect_credential_audit`
  and `list_credential_trails` tool shapes.
- `assertRetentionFloorPreservesAuditEvents` proves events older than the NFR-018
  floor remain present.
- `assertAuditStreamsNeverCompacted` proves `token.*`, `resource.*`, and `policy.*`
  streams refuse compaction.
- `brokeredDeployCredentialTrail()` supplies a brokered Cloudflare deploy fixture.

## Fixture Dependencies

This POC composes existing draft contracts:

- `identity-event-contract` for event validation and `foldCredentialAudit`.
- `snapshot-compaction-contract` for never-compact enforcement.

## Scope Boundaries

Included:

- CredentialAudit projection over `identity.*` / `token.*` streams.
- Per-principal grant/use/revoke timelines.
- Gateway and MCP query surface shapes.
- NFR-018 retention-floor and never-compact guards.

Excluded:

- Production `packages/cloud/` projector runtime.
- Live Gateway or MCP server wiring.
- OCSF/SIEM export (see `identity-ocsf-export-contract`).
- Token broker exchange (see S3-03 / HOBO-629).

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/credential-audit-projection-contract
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
