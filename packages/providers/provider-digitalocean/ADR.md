# @hobo/provider-digitalocean — Architecture Evidence

The DigitalOcean `CloudProvider`: the DigitalOcean row of the cross-cloud
equivalence table (control-plane.md) shipped as default Resource Definitions
behind the HOBO-87 authoring contract — factory
(`createDigitalOceanProvider`), typed `.with()` builders
(`digitalocean.with.appPlatform/droplet/managedPostgres/spaces/managedValkey`),
capability declarations + equivalence map, `realize()` emitting the
primary-lane Pulumi `IacProgram`, a runtime `client()` per port, the published
Capability Manifest, a full allocatable Yard catalog
(`digitaloceanYardSpec()`), and bearer-token `ResourceResolver`s for the
convergent half of that catalog.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): equivalence
  mappings, the manifest index, declared cost facts, the credential-locator
  auth posture, the realized IacProgram shapes, the Yard catalog row, and the
  resolver outcome.
- CUE constraints in `data-models/provider_digitalocean.cue` bound every
  protobuf message (resource classes pinned to `digitalocean:*`, product ids to
  `digitalocean.<slug>/v<n>`, prices to decimal strings, `staticSecrets` to
  `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): manifest
  publication, the auth posture, the realize emission, and the
  reconcile-twice convergence property — asserted against the recorded
  interactions in `test/realize.test.ts` and `test/resolvers.test.ts`.

## Parse, don't validate

`parsePublishedManifest` is the parse, don't validate boundary for the
published well-known documents: untrusted manifest JSON becomes a parsed
derived result (schema ids checked, static secrets rejected, non-empty
capabilities) or structured errors — no broad DTO checks downstream.
`assertLocalIacProgram` re-parses every emitted program into a derived parsed
domain program before it leaves the package boundary in tests. On the resolver
path, `parseJsonRecord` turns an untrusted API body into a parsed derived
record or a typed refusal, `resolveToken` turns an untrusted `credentialRef`
into a locator or a refusal, and `slotBinding()` in `@hobo/core` is the parse
boundary every catalog row crosses.

## Credentials

DigitalOcean's v2 API takes a personal access token and ships no OIDC
federation endpoint, so the published posture is HoBo's own: the Yard broker
holds custody and the resolver is handed a *locator* (`scheme://path`), which
it exchanges through an injected `resolveCredential`. `staticSecrets: false` is
a parse-enforced claim about this package — no material is stored, logged, or
published anywhere in it — and explicitly not a claim that DigitalOcean has
shipped workload identity. Token-shaped `credentialRef` values are refused
(`RESOLVER_CREDENTIAL_NOT_A_REF`), and provider error text is redacted before
it reaches a message or a diagnostic.

## Event architecture

The provider participates in the control-plane command/event loop without
holding state of its own: `registerProviderFact`/`provider.Approved` facts (the
M0 registry stream) carry its manifest snapshot into the event store; the
Planner's Matching folds the registry materialized view and records
`match.Decided`; the ResourceActor (single-writer actor) dispatches the
realized IacProgram or drives the resolvers, and outputs land as
`resource.Provisioned` facts whose bindings feed the runtime `client()`.
`normalizeDigitalOceanYardSignal` is the provider-side fold that turns native
App Platform / VPC signals into `yard.*` events for that same event store, and
`digitaloceanEventStoreFoldDescriptor()` registers it. Read stores (registry
catalog, deployment view) rebuild from the log — the provider publishes
documents, never authoritative state; a capability-manifest snapshot is
re-derivable at any time, so no snapshot in this package is load-bearing.

## Cost facts

Declared, real list-price magnitudes per SKU (App Platform instance-hour,
Spaces GB-month, Managed PostgreSQL instance-hour, Managed Valkey node-hour)
with monthly free-tier facts — honest nonzero inputs for min-cost ranking,
marked `declared-provider` pending signed billing feeds. DigitalOcean prices
most plans per month; those are divided by 730 so the marginal price is
comparable with the hourly providers rather than being an order of magnitude
out.
