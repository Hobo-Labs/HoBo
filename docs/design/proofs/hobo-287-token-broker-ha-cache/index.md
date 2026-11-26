# HOBO-287 Token Broker HA Cache Proof

This executable proof backs the Plan 06 token broker HA hardening slice: broker
unavailability must degrade within a bounded credential-cache renewal-grace
window, then fail closed.

Design refs:

- [ai-native-agent-auth.md](../../ai-native-agent-auth.md#plan-06)
- [ADR-0008](../../adr/02-identity-security.md#adr-0008)
- [ADR-0100](../../adr/02-identity-security.md#adr-0100)
- [HOBO-266 partition grace spike](../../../../src/draft/technical-proofs/svid-partition-grace-spike)

Executable artifact:

- [`src/draft/technical-proofs/token-broker-ha-cache-contract`](../../../../src/draft/technical-proofs/token-broker-ha-cache-contract)

Acceptance evidence:

- Broker downtime shorter than renewal grace renews an in-flight workload from
  the shared credential cache with no data-plane outage.
- Broker downtime beyond renewal grace fails closed with
  `identity.PartitionGraceExpired` and `token.Denied`.
- A failed broker replica transparently fails over to another healthy replica.
- Lease bounds match the HOBO-266 recommendation: 15 minute TTL, rotate at 10
  minutes, max 5 minute renewal grace, never beyond SVID `notAfter`.
- A poisoned cache entry whose backing token was revoked is invalidated before
  renewal.
- A workload cannot pin a stale cached token to dodge revocation.
- Scope widening while Identity is unavailable requires live Identity and is
  denied from the cache.

Scope boundary:

- No production broker deployment, OIDC issuer HA, SVID rotation happy path,
  provider STS/cloud integration, or cross-Yard failover.
- No new architectural decision; this consumes the existing Plan 06, ADR-0008,
  ADR-0100, and HOBO-266 requirements.
