---
type: Architecture Decision Record
title: "First-class Connections on the Yard token broker"
description: "First-class Connections on the Yard token broker"
tags: [hobo, design]
---

# ADR: First-class Connections on the Yard token broker

## Status

Accepted (implemented)

## Context

Cross-app access (XAA / OBO) previously treated long-lived refresh material as
an implicit side-effect of `connector("asana")` usage. Agents and humans could
not authorize a named Connection once and reuse it safely with full audit.

## Decision

1. **Connection** is a durable, event-sourced aggregate **owned by Station**
   (control-plane occupancy, ADR-0131). The token broker still mints short-lived
   tokens from Station-owned Connections (`@hobo/identity` `ConnectionService`);
   records carry optional `stationId` (required on create when Station context
   is available; dual-read for pre-Station events).
2. Fields: id, alias, provider, flow, status, subject, installationId,
   grantedScopes, metadata, **credentialRef** (opaque vault ref only), tenant,
   timestamps, seq.
3. Event family (never-compact security-audit retention):
   - `connection.Created`
   - `connection.AuthorizationStarted`
   - `connection.Authorized`
   - `connection.TokenIssued` (links `token.Granted` via connectionId)
   - `connection.HealthChanged` / `connection.NeedsReauth`
   - `connection.Rotated`
   - `connection.Revoked`
4. Token preference order remains keyless-first:
   1. OIDC federation (no Connection required)
   2. Healthy matching Connection → `connection-obo` short-lived token
   3. Vault static-key fallback (bounded)
5. Surfaces: CLI verb `connection` (subcommands create/authorize/list/get/revoke/rotate);
   MCP tool `connection` (1:1 verb parity, NFR-004). Bindles declare
   `requireConnection({ provider, scopes })` without provider pins.
6. Policy: deny-by-default `connection.use`; subject-bound; cross-tenant requires
   audited admin. Secrets never appear in events, logs, or agent runtimes.

## Consequences

- Setup-at-most-once is concrete for humans and agents.
- CredentialAudit folds `connection.*` into the user → agent → Connection → app chain.
- HONEST SCOPE: live XAA IdP federation adapters remain provider-specific;
  local vault + OBO material path is fully exercised offline.

## Related

- Plan 06 `docs/design/ai-native-agent-auth.md`
- ADR-0084 (XAA), ADR-0074 (deny-by-default)
