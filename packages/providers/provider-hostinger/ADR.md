# @hobo/provider-hostinger — Architecture Evidence

The Hostinger `CloudProvider`: the Hostinger row of the cross-cloud equivalence
table (control-plane.md) shipped as default Resource Definitions behind the
HOBO-87 authoring contract — factory (`createHostingerProvider`), typed
`.with()` builders (`hostinger.with.vps/webHosting/mysql`), capability
declarations + equivalence map, `realize()` emitting the primary-lane Pulumi
`IacProgram`, a runtime `client()` per port, the published Capability Manifest,
a full allocatable Yard catalog (`hostingerYardSpec()`), and bearer-token
`ResourceResolver`s for the part of that catalog with a convergent API.

## The decision that shapes this package: allocation is a purchase

On every other provider in this repo, "allocate a resource" is an API call. On
Hostinger it is a billing order — a VPS, a hosting plan and the MySQL database
that comes with it are all obtained by buying a plan, and the public API manages
instances you already own. That is the shape of the product, not a gap in the
API, and this package is built around it rather than papering over it:

- The resolvers **adopt and converge** rather than create. `reconcile()` finds
  the instance you bought, brings its mutable state to what the request asks
  for, and reports what it found.
- When there is nothing to adopt, the refusal names the purchase as the missing
  step (`purchaseRequired`) instead of placing the order.
- That refusal is enforced **below** this code: the transport guard in
  `src/transport.ts` allowlists `/api/vps/v1/` and `/api/dns/v1/` and
  deliberately not `/api/billing/v1/`, so a later edit cannot quietly start
  spending the account's money without also widening a policy a reviewer sees.
  `HOSTINGER_EXCLUDED_PATH_PREFIXES` carries the reason with the code.
- `delete()` on a VPS refuses for the same reason: destroying one means
  cancelling a paid plan.

`adopt` is therefore the *normal* outcome on this provider rather than an edge
case, which is worth stating because on the other providers it signals that
something unmanaged was found.

## No inline secrets, on a surface that offers one

Hostinger's VPS setup call accepts a root password. Accepting one through
`desired` would put credential material in a `ResolveRequest`, and a
`ResolveRequest` is recorded in the event log — permanently, whatever the caller
intended. `refuseInlineSecrets` rejects `password`, `rootPassword`,
`privateKey` and `sshPrivateKey` before a call is made, and setup is expressed
with `desired.publicKeyId` — the id of an SSH key already uploaded to the
account, which is a reference rather than a secret.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): equivalence
  mappings, the manifest index, declared cost facts, the credential-locator
  auth posture, the realized IacProgram shapes, the Yard catalog row, and the
  resolver outcome.
- CUE constraints in `data-models/provider_hostinger.cue` bound every protobuf
  message (resource classes pinned to `hostinger:*`, product ids to
  `hostinger.<slug>/v<n>`, prices to decimal strings, `staticSecrets` to
  `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): manifest
  publication, the auth posture, the realize emission, and the
  adopt-twice-without-mutating property — asserted against the recorded
  interactions in `test/realize.test.ts` and `test/resolvers.test.ts`.

## Parse, don't validate

`parsePublishedManifest` is the parse, don't validate boundary for the published
well-known documents: untrusted manifest JSON becomes a parsed derived result
(schema ids checked, static secrets rejected, non-empty capabilities) or
structured errors — no broad DTO checks downstream. `assertLocalIacProgram`
re-parses every emitted program into a derived parsed domain program before it
leaves the package boundary in tests. On the resolver path, `expectRecord` and
`expectList` turn an untrusted API body into a parsed derived record or a typed
refusal (Hostinger answers some collections bare and some wrapped in `{data}`,
and both are parsed rather than coerced), `resolveToken` turns an untrusted
`credentialRef` into a locator or a refusal, and `slotBinding()` in `@hobo/core`
is the parse boundary every catalog row crosses.

## Event architecture

The provider participates in the control-plane command/event loop without
holding state of its own: `registerProviderFact`/`provider.Approved` facts (the
M0 registry stream) carry its manifest snapshot into the event store; the
Planner's Matching folds the registry materialized view and records
`match.Decided`; the ResourceActor (single-writer actor) dispatches the realized
IacProgram or drives the resolvers, and outputs land as `resource.Provisioned`
facts whose bindings feed the runtime `client()`. `normalizeHostingerYardSignal`
is the provider-side fold that turns native VPS and DNS signals into `yard.*`
events for that same event store, and `hostingerEventStoreFoldDescriptor()`
registers it. Read stores (registry catalog, deployment view) rebuild from the
log — the provider publishes documents, never authoritative state; a
capability-manifest snapshot is re-derivable at any time, so no snapshot in this
package is load-bearing.

## Cost facts

The VPS fact is a monthly plan price divided by 730, so it is comparable with
the hourly providers; Hostinger's multi-year discount is a real saving it does
not model, which over-states the marginal cost rather than under-stating it. The
MySQL fact is a genuine zero and not a placeholder: the database is included
with a hosting plan rather than billed separately, so the marginal cost of the
database itself really is nothing, and the `included: 730` free-tier fact is
what carries "it comes with the plan". Both are marked `declared-provider`
pending signed billing feeds.
