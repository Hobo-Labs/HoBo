# @hobo/broker

The **HoBo Broker**: the policy-governed authority that actually brokers
Bindle/Camp/Yard/Junction placements **across providers**, spins resources up
and down, and hands accepted work to delivery — based on the configured
policies the broker itself maintains. It is the runtime counterpart of the
[Meta-cloud Broker design](../../docs/design/hobo-broker.md); the Meta-cloud
Broker artifact vocabulary (Contract Manifest → Resolution Receipt /
Resolution Rejection) is preserved here as the receipt/rejection wire shapes.

This broker is **distinct** from the Identity token broker (ADR-0008) and the
connector runtime broker (HOBO-235): those broker *credentials*; this package
brokers *placements*. The connector registry below stores `credentialRef`
pointers into the token broker — never raw secrets.

## What it wraps

The broker is a wrapper around five planes, each behind a port so engines can
be swapped without touching the brokering pipeline:

| Plane | Port | Default engine | Alternate engine (shipped in this package) |
|---|---|---|---|
| Policy | `GatePlane` (OPA-shaped request/decision documents) | `@hobo/contracts` policy pack (imported and **run**, not reinvented) | **Rego** via `createOpaGatePlane` — OPA Data API decision at `hobo/broker/decision`, fail-closed (`policy-engine-unavailable`), pinned by `broker_policy_opa.pact.json` |
| Contracts | `GatePlane` (can-deploy compatibility) | `@hobo/contracts` Gatekeeper (PACT-style boundary semantics) | an external Pact broker verification feed (port-compatible) |
| Billing | `BillingPlane`; optional `BillingPlaneV2` for quote-pinned requests | in-proc budget + spend-cap + quota checks | `createMeteredBillingPlane` folds `meter.UsageRecorded` facts into observed spend; `createPricingBillingPlaneV2` verifies `@hobo/pricing` quote/catalog hashes and compares exact incremental billed USD against limits |
| Delivery | `DeliveryPlane` | `renderArgoApplication` → Argo CD Application documents; `in-proc` executor handoff | `createArgoCdDeliveryPlane` — live Argo CD applications API submission, token via the token broker, fail-closed, pinned by `broker_delivery_argocd.pact.json` |
| Connectors | `ConnectorRegistry` | event-sourced registry of `github-app`, `pulumi`, `azure`, `vercel`, `cloudflare`, `custom` configs | an external connector catalog |

Beyond M0, this package also ships:

- **Receipt integrity** — Ed25519 detached signatures over canonical JSON for
  every receipt and rejection (`signResolution`/`verifyResolution`,
  `broker.ResolutionSigned` facts).
- **The closed rejection matrix** (`REJECTION_MATRIX`) — every broker-owned
  rejection code pinned to its plane and an agent-actionable remediation,
  test-enforced against the pipeline.
- **Cedar** as the second external policy language (`createCedarGatePlane`,
  fail-closed, pinned by `broker_policy_cedar.pact.json`) beside Rego.
- **Broker Environments** (admin controls): `publishEnvironmentFact` /
  `approveEnvironmentFact` / `foldBrokerEnvironments`; resolutions against an
  unapproved environment or a stale pinned catalog snapshot reject
  (`environment-unapproved`, `catalog-snapshot-stale`), and eligibility is
  bounded to the environment's approved providers.
- **The hosted authority surface** — `createBrokerHttpHandler` / `serveBroker`
  expose resolve/scale/deliver/rejection-matrix over HTTP, and the resolve
  route is PROVIDER-verified against `broker_resolution.pact.json`
  (`contracts/provider/`). The `hobo broker` CLI verb (and its derived MCP
  tool) runs the same pipeline against the composed Yard's live registry.

Branding note: product surfaces call this component **the Conductor**; code
and technical docs keep **broker**.

Placement itself consumes any `BrokerCatalog` — a structural mirror of
`@hobo/cloud`'s `PlannerRegistry`, so the Yard's live provider catalog plugs
in directly.

## Command/event model

The broker is an **actor**: it consumes commands (`resolve`, `scale`,
`deliver`, connector `register`/`disable`), coordinates durable state through
the facts it emits, and never mutates a query read model directly. Event
families:

- `broker.Requested` → `broker.Resolved` (receipt) or `broker.Rejected`
  (structured per-plane reasons), with the Gatekeeper's `policy.Decided` /
  `gatekeeper.Decided` facts appended to the same stream for replay.
- `broker.ScaleRequested` — spin up/down/zero directives.
- `broker.DeliverySubmitted` — delivery-plane handoff.
- `connector.Registered` / `connector.Disabled` — connector registry facts.

Query surfaces are event-driven: `foldBrokerDecisions` and
`foldConnectorRegistry` are pure folds over the **event store** stream into
**materialized view** rows (each **projection** rebuilds from zero), and
`snapshotBrokerDecisions`/`restoreBrokerDecisions` persist a **snapshot** of
the current rows to a **read store** for cached current reads; replaying the
stream over a restored snapshot yields the same view.

## Parse, don't validate

Untrusted policy documents, brokering requests, connector configs, and scale
directives cross exactly one parser boundary (`parseBrokerPolicySet`,
`parseBrokerRequest`, `parseConnectorConfig`, `parseScaleDirective`). The
parsers apply the protobuf + CUE constraints from `data-models/broker.proto`
and `data-models/broker.cue` and return refined **parsed domain types**
(`src/types.ts`, including the branded `PolicyHash` derived type), so invalid
values are unrepresentable past the boundary — core functions never re-check
raw DTOs. `quoteHash` and `pricingCatalogHash` (or their snake_case spellings)
must be supplied together as full lowercase SHA-256 digests. Requests without
the pair use only legacy `BillingPlane.authorize({ spendEstimateUsd, billing })`.
Requests with the pair use only `BillingPlaneV2`; if it is not configured, the
broker rejects with `quote-authorization-unavailable` rather than falling back
to the estimate. Invalid or ineligible quotes reject with
`quote-authorization-failed`. Accepted V2 receipts and `broker.Resolved` data
carry both pins; legacy receipt and event shapes do not gain those fields.

## Policy semantics

Placement policies are maintained per topology scope kind. The effective
policy for a request merges junction → yard → camp → bindle: narrower scopes
override choice-shaped fields (objective, allowed providers/regions, pins),
while restrictions **accumulate** — a junction broker admin's
`requireExplicitCamps` lockdown or denied-provider list can never be relaxed
by a narrower policy. Every receipt and rejection pins `policyHash` (the
content address of the whole policy set) and `catalogHash`, so a decision is
replayable against the exact policies and catalog that produced it.

## Boundary contract

The consumer-driven PACT contract for the resolve boundary lives in
[`contracts/pacts/broker_resolution.pact.json`](contracts/pacts/broker_resolution.pact.json),
exercised by `contracts/consumer/broker-resolution-boundary.test.ts`.

## Verification

```sh
pnpm --filter @hobo/broker test
pnpm --filter @hobo/broker test:contract:consumer
```
