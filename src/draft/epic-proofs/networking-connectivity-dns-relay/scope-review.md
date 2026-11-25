# Adversarial Scope Review

## Accepted POC Clusters

| Cluster | Requirement proved | Kept | Rejected or revised | Drift risk controlled |
|---|---|---|---|---|
| Connectivity tier and Yard topology | Lowest legal private connectivity across Yard boundaries | Tier selection, Yard manifest fold, Junction mirrored halves, topology conflict denial | No production provider provisioning or live network calls | Fixture stays deterministic and every provider edge is mocked |
| DNS, Gateway, ACME, routing | Custom-domain promotion is validation-first | Shadow DNS, four validation checks, ACME DNS-01, private ACME, staged gateway routing | No live DNS mutation, no public ACME call, no DNS adapter secrets | Simulation asserts `liveZoneWrites = 0` |
| Relay | Private executor uses outbound-only SVID-authenticated tunnel | Register, attach, target dispatch, SSRF denial taxonomy | No sockets, no real private network, no credential material movement | Epic-level taxonomy maps provider codes to abuse cases |
| Tenant ingress | `ctx.tenant` exists before handler and mismatches fail closed | Subdomain/JWT resolution and region-pooled placement | No tenant datastore, no auth provider implementation | Tenant claims remain mocked boundary |

## Review Questions

Each accepted POC maps to the selected Networking epic, a persona, a BDD scenario, a vertical slice, a boundary map, and a Pact strategy in the ledger. POCs that primarily belong to Identity, Policy, Reliability, or Control Plane are not copied into this path; they are represented only through explicit mocked boundaries.

## Requirement Changes

No large requirement change was needed. Two implementation refinements were captured in the reference architecture:

- Relay provider codes are normalized into an epic-level abuse taxonomy for SSRF, forward-proxy, and credential-egress review.
- Private ACME requires an explicit air-gapped profile; the reference fixture now includes it and documents private ACME as mocked-provider-unavailable for provider verification.
