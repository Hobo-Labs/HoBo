# @hobo/provider-hetzner — Architecture Evidence

The Hetzner `CloudProvider`: the Hetzner row of the cross-cloud equivalence
table (control-plane.md) shipped as default Resource Definitions behind the
HOBO-87 authoring contract — factory (`createHetznerProvider`), typed `.with()`
builders (`hetzner.with.cloudServer/loadBalancer/objectStorage/volume`),
capability declarations + equivalence map, `realize()` emitting the
primary-lane Pulumi `IacProgram`, a runtime `client()` per port, the published
Capability Manifest, a full allocatable Yard catalog (`hetznerYardSpec()`), and
bearer-token `ResourceResolver`s for the convergent part of that catalog.

## Deliberate narrowness

Hetzner sells virtual machines, networking and storage. It sells no managed
database, cache, queue, topic or secret store, so this package declares two
equivalence classes rather than six and leaves five Yard slots empty. That is
the architecture decision worth recording: an equivalence row for a product the
provider does not offer makes Matching answer `full` for a capability nothing
can realize, and "Postgres you install yourself on a Cloud Server" is a thing a
person can do rather than a product a catalog can allocate. An app that needs
Postgres gets a truthful `none` here and is placed on a provider that has one.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): equivalence
  mappings, the manifest index, declared cost facts, the credential-locator
  auth posture, the realized IacProgram shapes, the Yard catalog row, and the
  resolver outcome.
- CUE constraints in `data-models/provider_hetzner.cue` bound every protobuf
  message (resource classes pinned to `hetzner:*`, product ids to
  `hetzner.<slug>/v<n>`, prices to decimal strings, `staticSecrets` to `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): manifest
  publication, the auth posture, the realize emission, and the reconcile-twice
  convergence property — asserted against the recorded interactions in
  `test/realize.test.ts` and `test/resolvers.test.ts`.

## Parse, don't validate

`parsePublishedManifest` is the parse, don't validate boundary for the published
well-known documents: untrusted manifest JSON becomes a parsed derived result
(schema ids checked, static secrets rejected, non-empty capabilities) or
structured errors — no broad DTO checks downstream. `assertLocalIacProgram`
re-parses every emitted program into a derived parsed domain program before it
leaves the package boundary in tests. On the resolver path, `parseJsonRecord`
turns an untrusted API body into a parsed derived record or a typed refusal,
`resolveToken` turns an untrusted `credentialRef` into a locator or a refusal,
and `slotBinding()` in `@hobo/core` is the parse boundary every catalog row
crosses.

## Four surfaces, three policies, one exclusion

Hetzner splits its products across four hosts, and `src/transport.ts` gives
each allowlisted one its *own* policy rather than widening a shared host list:
the Cloud API (`api.hetzner.cloud/v1`), the unified API (`api.hetzner.com/v1`,
`storage_box*` paths only), and Object Storage
(`<location>.your-objectstorage.com`, SigV4 against a separate key pair). Two
of those take the same kind of bearer token, which is exactly why they are not
merged: a policy naming both hosts could not tell a Cloud API path requested
from the unified origin from a legitimate one.

The Robot API stays out. It is behind HTTP Basic with the account's *web
console password*, and nothing this package catalogs needs it. It is named in
`HETZNER_EXCLUDED_SURFACES` with its credential and the reason, so widening the
guard is an edit a reviewer sees rather than a pattern that quietly matches a
new host.

An earlier revision of this ADR justified excluding `hetzner.storage-box/v1` by
that same Robot argument. It was wrong: Storage Boxes had moved to the unified
API, and the 404 this package observed on the *Cloud* API was evidence of a
move, not of unreachability. Every catalogued product now has a resolver.

## Credentials

The Cloud API takes a project-scoped token and ships no OIDC federation
endpoint, so the published posture is HoBo's own: the Yard broker holds custody
and the resolver is handed a *locator* (`scheme://path`), exchanged through an
injected `resolveCredential`. `staticSecrets: false` is a parse-enforced claim
about this package — no material is stored, logged, or published anywhere in it
— and explicitly not a claim that Hetzner has shipped workload identity.

## Event architecture

The provider participates in the control-plane command/event loop without
holding state of its own: `registerProviderFact`/`provider.Approved` facts (the
M0 registry stream) carry its manifest snapshot into the event store; the
Planner's Matching folds the registry materialized view and records
`match.Decided`; the ResourceActor (single-writer actor) dispatches the realized
IacProgram or drives the resolvers, and outputs land as `resource.Provisioned`
facts whose bindings feed the runtime `client()`. `normalizeHetznerYardSignal`
is the provider-side fold that turns native server and network signals into
`yard.*` events for that same event store, and
`hetznerEventStoreFoldDescriptor()` registers it. Read stores (registry catalog,
deployment view) rebuild from the log — the provider publishes documents, never
authoritative state; a capability-manifest snapshot is re-derivable at any time,
so no snapshot in this package is load-bearing.

## Cost facts

Declared, real list-price magnitudes per SKU (a `cx22` Cloud Server per hour,
Object Storage per GB-month) marked `declared-provider` pending signed billing
feeds. Hetzner publishes an hourly price alongside a monthly cap; the hourly
figure is used directly, and the cap is a real saving these facts do not model.
