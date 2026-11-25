# Control-plane authz cache contract

HOBO-200 proof package for Plan 29, ADR-0074, and ADR-0021. It models the in-Yard control-plane authorization hot path: local policy evaluation, decision-cache TTL, revocation propagation, pack-version invalidation, and async `policy.Decided` audit emission.

## Stated bounds

- Control-plane authz hot-path p99 target: `25ms`
- Crew-operator repair-loop p99 target: `10ms`
- Decision-cache TTL: `300000ms`
- Revocation propagation bound: `30000ms`

The propagation bound is intentionally tighter than the cache TTL. A revocation observed after the bound fails closed, and an observed revocation invalidates cached allows before the TTL can keep them alive.

## Scope

In scope:
- cache-keyed in-Yard policy decisions with no management-plane round trip;
- benchmark report with p99, cache-hit ratio, and management-plane call count;
- bounded revocation handling for high-frequency Crew-operator paths;
- pack-version keyed invalidation;
- async audit emission for cache misses and hits.

Out of scope:
- policy-engine rule logic from HOBO-133;
- SCIM provisioning latency;
- OCSF export/shipping from HOBO-175.

## Run

```sh
npm --prefix src/draft/technical-proofs/control-plane-authz-cache-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Control Plane Authz Cache Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
