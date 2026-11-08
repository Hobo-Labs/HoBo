# ADR: @hobo/broker — the HoBo Broker as a plane-wrapping placement authority

## Status

Accepted.

### Hosting financial authority hardening

Yard-first resolution requires complete normalized quotes, bound policy proof and
durable admission before issuing a funded receipt or invoking generation. A
single financial aggregate reserves money, provider-account limits and shared
entitlements atomically; unknown effects retain commitments. Expected cost and
the liability bound are separate values. The concrete local adapter uses SQLite
transactions and an append-only generated event journal; distributed hosts must
provide equivalent shared transactional authority. Budget ID, period and policy
revision are independent identity dimensions. Cap changes and rollover do not
implicitly forgive outstanding or uncertain work.

## Context

The design suite defines a Meta-cloud Broker as a decision/receipt authority
(`docs/design/meta-cloud-broker.md`), the Gatekeeper as the composed
policy/contract/cost gate (`@hobo/contracts`), and the Yard Planner as the
in-Yard placement engine (`@hobo/cloud`). Nothing composed these into the
brokering surface the product describes: one authority that brokers
Bindle/Camp/Yard/Junction placements across providers under configured
policies, wraps policy enforcement (OPA-shaped), contract enforcement
(PACT-style), billing enforcement, delivery (Argo), and a connector registry.

## Decision

1. **Compose, don't reinvent.** The broker imports and runs the
   `@hobo/contracts` Gatekeeper (which itself runs `@hobo/policy`) as its
   default gate plane. OPA remains a swappable engine behind the OPA-shaped
   `GatePlane` port, consistent with the planned `@hobo/provider-opa` adapter
   (`docs/design/contracts-policy-flags.md`).
2. **Structural catalog input.** Placement consumes a `BrokerCatalog` that
   structurally mirrors `@hobo/cloud`'s `PlannerRegistry` instead of importing
   it, keeping `@hobo/broker` inward of `@hobo/cloud` (the same inward-only
   dependency discipline `packages/cloud` uses for providers).
3. **Policy merge, lockdown-preserving.** Effective placement policy merges
   junction → yard → camp → bindle; choice fields are overridden by narrower
   scopes, restrictions (denied providers, `requireExplicitCamps`) accumulate.
   This encodes the documented junction-broker-admin lockdown so a narrower
   policy cannot undo governance.
4. **Content-addressed decisions.** Every receipt/rejection pins `policyHash`
   and `catalogHash` so decisions replay against the exact policy set and
   catalog that produced them (same discipline as the registry catalog hash
   and the Meta-cloud Broker receipt integrity requirement).
5. **Delivery as rendered documents.** The Argo delivery plane renders Argo CD
   Application documents as pure data behind `DeliveryPlane`; live submission
   is an adapter concern, so tests and dry runs inspect exactly what would be
   applied.
6. **Connector registry stores configuration, never credentials.**
   Well-known kinds (`github-app`, `pulumi`, `azure`, `vercel`, `cloudflare`)
   have required-setting parsers; `credentialRef` points into the token broker
   (ADR-0008). The HoBo Broker stays distinct from the token broker and the
   connector runtime broker, per the meta-cloud-broker adversarial
   requirement that the terms never conflate.

7. **Rego is the external policy language; the adapter fails closed.**
   `createOpaGatePlane` lowers the Policy IR request onto the OPA Data API
   (`hobo/broker/decision`) and parses the Rego result defensively; any
   engine unavailability denies with `policy-engine-unavailable`. Cedar
   lands behind the same port later.
8. **Signatures are detached and canonical.** Ed25519 over recursively
   key-sorted JSON keeps `ResolutionReceipt`/`ResolutionRejection` wire
   shapes stable while making every field tamper-evident (HOBO-529).
9. **The rejection matrix is a closed, tested catalog.** Reject paths may
   only emit cataloged codes (HOBO-528); the contracts plane's codes remain
   owned by `@hobo/contracts`.
10. **Environments gate resolutions; approval is a separate fact.** A
    `BrokerEnvironment` is published (proposal) and approved (admin fact)
    as distinct events; the broker resolves only against approved state,
    rejects stale pinned catalog snapshots, and bounds eligibility to the
    environment's approved providers (HOBO-526/527).
11. **The hosted surface is provider-verified.** `createBrokerHttpHandler`
    replays the resolution pact from the provider side, so the hosted HTTP
    authority and the consumer contract cannot drift; `serveBroker` binds it
    to node:http for hosted operation, and `hobo broker` (verb #28, with its
    parity-derived MCP tool) fronts the same pipeline on the CLI.

## Consequences

- The Yard gateway (or `hobo` CLI) can wire the live `PlannerRegistry` and
  real policy packs into the broker without new adapters.
- Swapping OPA/Argo/metering engines is additive: implement the port, pass it
  to `createBroker`.
- The broker's decision stream is replayable end to end; read models are
  rebuildable folds, so no broker state exists outside the event store.
