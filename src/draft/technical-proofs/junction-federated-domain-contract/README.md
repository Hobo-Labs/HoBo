# Junction Federated Domain Contract

Independent proof for HOBO-163.

This package models the Junction-owned cross-cloud custom-domain fold that
fronts Camps in multiple provider-specific Yards without pushing zone ownership
down to the provider-agnostic Bindle.

## Contract Surface

- `federateJunctionDomain()` accepts the target domain, member Yards, their
  `hobo:dns` shadow adapters, validation fixtures, and health samples.
- The Junction emits one `resource.JunctionDomainHalfPlanned` delivery per
  Yard, landing in `yard:<id>:domains`.
- Each Yard receives only its own DNS record and ACME DNS-01 certificate
  challenge half.
- Every half is staged through the shadow `hobo:dns` path and the mandatory
  domain validation gate before the plan can become `ready`.
- Cross-Yard failover uses only validation-cleared, healthy Camps.
- `livePromotions` remains empty in this proof; live DNS promotion belongs to
  the staged cutover/domain rollout slices.

## Proof Boundaries

This proof composes the existing HOBO-113 validation gate, HOBO-144 certificate
issuance shape, HOBO-151 routing policy, and HOBO-159 Junction half-delivery
model. It does not implement single-Yard domains, live DNS promotion, concrete
provider DNS APIs, tenant routing, or gateway/data-plane load balancers.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\junction-federated-domain-contract test
```

The checks cover cross-cloud domain federation into per-Yard DNS/cert halves,
per-half validation before any live-zone mutation, failover only to a cleared
target, rejection of leaked Yard halves, and refusal to front a residency-pinned
Camp from a forbidden region.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Junction Federated Domain Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
