# Token Broker HA Credential Cache Contract

HOBO-287 proof package for the Plan 06 token broker HA requirement. It models a
multi-replica broker with a shared bounded credential cache and the signed
renewal-grace lease from HOBO-266.

Design refs:

- [Plan 06: Agent identity and the token broker](../../../../docs/design/ai-native-agent-auth.md#plan-06)
- [ADR-0008](../../../../docs/design/adr/02-identity-security.md#adr-0008)
- [ADR-0100](../../../../docs/design/adr/02-identity-security.md#adr-0100)
- [HOBO-266 partition grace spike](../svid-partition-grace-spike)

Behavior pinned by `npm test`:

- Broker failover selects a healthy replica when the primary broker is down.
- In-flight workloads renew same-or-narrower credentials from cache during
  brief Identity/broker unavailability inside signed renewal grace.
- Downtime beyond signed grace fails closed and emits degradation evidence.
- The broker uses the HOBO-266 15 minute TTL, 10 minute rotate-at point, and
  maximum 5 minute renewal-grace bound without extending past SVID `notAfter`.
- Revoked cached tokens are invalidated before renewal.
- A workload-supplied stale pinned token cannot dodge revocation.
- Scope widening during Identity unavailability requires live Identity and is
  denied from cache.

Scope boundary:

- No production broker, OIDC issuer, SPIFFE/SVID rotation, provider STS, or
  cloud integration.
- No cross-Yard failover.
- No new architectural decision; this consumes Plan 06, ADR-0008, ADR-0100, and
  the HOBO-266 partition recommendation.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Token Broker Ha Cache Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
