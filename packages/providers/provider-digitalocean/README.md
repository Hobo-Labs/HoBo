# @hobo/provider-digitalocean

The DigitalOcean `CloudProvider`: the DigitalOcean row of the cross-cloud
equivalence table, a full allocatable Yard catalog, and bearer-token
`ResourceResolver`s for the convergent half of it.

```sh
pnpm --filter @hobo/provider-digitalocean test
```

## What this package ships

- **Equivalence → default Resource Definitions** (`EQUIVALENCE_CLASSES` /
  `createDigitalOceanProvider`), with Matching's `satisfies` answering
  full/partial/none rather than fabricating parity.
- **`realize()` → `hobo.iac-program/v1`** for the primary Pulumi lane, with
  bind edges resolving as `${resources.<dep>.outputs.binding}` across a whole
  deployment plan.
- **A typed authoring surface**: `digitalocean.with.appPlatform(…)` and friends
  emit provider-specific option blocks that are inert for other providers, and
  the slot factories (`appPlatform.service()`, `managed.postgres()`, `spaces()`,
  …) each own one `(slot, profile, productId)` triple so a profile string is
  never typed by hand.
- **A default Yard catalog** (`digitaloceanYardSpec()`): what DigitalOcean *can*
  allocate, per slot, as canonical rows `@hobo/yards` parses.
- **Direct API resolvers** (`digitaloceanResolvers()`): read-or-create
  reconciliation against `api.digitalocean.com/v2` over an injected, guarded
  transport.
- **The published Capability Manifest**, with declared cost facts and a
  credential-locator auth posture that stores no material.

## Honest scope

- **No live deploy is proven here.** The resolvers are exercised against an
  *injected fake* transport modelling a DigitalOcean team. A real deploy
  additionally needs a real token, real network egress, and a real account,
  none of which a unit test supplies.
- **All 15 catalogued products have resolvers**
  (`DIGITALOCEAN_RESOLVED_PRODUCT_IDS`), including Spaces over SigV4 on its own
  guarded host with its own key pair, Block Storage volumes, DOKS clusters,
  Functions, and App Platform workers and jobs. A worker and a job really are *components
  inside* an app spec rather than standalone resources — but that shapes the
  resolver rather than preventing it: `PUT /v2/apps/{id}` replaces the whole
  spec, so a component converges by read-modify-write, which is idempotent. Two
  rules keep that safe, and both are tested: the component resolver never
  creates the app (that would race the resolver that owns it), and every part of
  the spec it does not own is carried through the write.
- **Functions has two layers, and only the outer one is on the v2 API.** An
  earlier revision of this README said there was no function resource at all.
  That was inspecting the wrong layer: `/v2/functions/namespaces` manages
  namespaces, and each namespace record carries an `api_host` serving an
  OpenWhisk-compatible API where a function *is* addressable —
  `GET|PUT|DELETE /api/v1/namespaces/{ns}/actions/{name}`, with
  `PUT ?overwrite=true` being create-or-replace and therefore idempotent. The
  non-determinism the old note described belongs to `doctl serverless deploy`,
  which builds an archive from a source tree; that is a build step in the CLI,
  not the API. `DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS` is now empty, and stays
  exported so that stops being true loudly rather than quietly.
- **The Functions namespace host is not a constant, and is still guarded
  exactly.** It is read from DigitalOcean's own control plane rather than from
  `desired` — a host in a property bag is a host an author could point anywhere,
  and the namespace credential would go with it — then checked against the
  `faas-<region>-<id>.doserverless.co` shape, and only then turned into a
  one-host policy. The conformance matrix probes a *different* namespace host as
  the foreign-host case, which is exactly what a shape check alone would wave
  through. The two credentials never cross: the personal access token addresses
  the control plane, the namespace's Basic credential addresses the namespace
  host, and neither appears in an output or a diagnostic.
- **This resolver deploys a function that is already built.** Producing the code
  or the archive stays outside it, the same way the App Platform resolvers
  forward a spec rather than assembling one — which is also what keeps the same
  request producing the same function twice.
- **No Resource Definitions are registered** for the `digitalocean.*` product
  ids, so a deploy against this Yard still fails closed at resolution
  (`YARD_BINDING_PRODUCT_UNKNOWN`).
- **Endpoint paths and field names are transcribed** from DigitalOcean's
  published API reference, not replayed against the running service. A field
  DigitalOcean has since renamed would fail at deploy time, not here.
- **Cost facts are `declared-provider`**, transcribed from the public pricing
  page rather than attested by a signed billing feed.
- **Two slots are deliberately empty.** DigitalOcean sells no first-party queue
  and no first-party secret store, so `queue`, `topic` and `secretRef` carry no
  rows. An empty slot is a gap an author can see; a row pointing at a product
  that does not exist is a portability lie.

## Convergence, and what it costs

Persisted `ref.physicalId` pins every observation and deletion to the exact provider
resource. A renamed resource cannot be replaced by a new resource under its former name;
a missing pinned resource requires a separately authorized replacement. Name discovery
must finish its bounded listing before asserting either absence or uniqueness.

Resolver outputs expose `ready` and `operationConfirmed`. Missing, provisioning and
drifting state remain unconfirmed. A mutation acknowledgement does not confirm the
operation; the durable host observes again, and retirement requires a fresh absent read.
App Platform keeps readiness false while another deployment is in progress.

Hosting `artifactDigest` and `ownershipRef` are canonical SHA-256 references. Droplet
creation writes them as native tags; App Platform writes general runtime environment
markers and reads them only from the active deployment's spec. Outputs never copy the
requested marker into evidence. Native tags identify a resource; an independent
application probe must still prove the served artifact and health. Explicit `userData`
can supply non-sensitive bootstrap code for a Droplet; it must not contain credentials.

Published rates carry `pricingStatus: "estimate"`; a static free-tier declaration is
not a tenant balance or a verified zero bill. Production admission uses fresh, bounded
quotes and the shared authority. `test/hosting-lifecycle.test.ts` and the actual
`#CostFact` CUE corpus exercise identity, asynchronous state, markers and price evidence.

DigitalOcean's v2 collections are keyed by a server-assigned id, not by the
name the caller chose, so "does my resource already exist" is a *listing*
question. Every `reconcile()` pages the collection — under a bounded page
budget — before it creates anything. That has three consequences worth stating
plainly:

1. **Two records with the same name is a refusal, not a coin flip.**
   DigitalOcean does not enforce name uniqueness on Droplets or Load Balancers,
   and picking "the first one" would make the managed resource depend on the
   order the API answered in.
2. **An exhausted page budget is a refusal too.** Concluding "absent" from a
   budget that ran out would create a duplicate of a resource on the page
   nobody read. Raise `maxListPages` if the team really is that large.
3. **Provisioning is asynchronous and nothing here polls.** A create comes back
   `status: "creating"` and that lands in `diagnostics` as *accepted, not
   confirmed*. A resolver that blocked a deploy on a provider's provisioning
   clock would be worse than one that reports the truth.

`"replace"` is never emitted. Replacing a database or a Droplet destroys data,
so drift on an immutable field (region, engine, image) is reported as a
diagnostic and left for a human.

## Parse, don't validate

Every untrusted value crosses a parse boundary that returns a derived parsed
type or a typed refusal: `parsePublishedManifest` for the published well-known
documents, `parseJsonRecord` for an API response body, `resolveToken` for a
`credentialRef`, and `slotBinding()` in `@hobo/core` for every catalog row.
Downstream code never re-checks a DTO.

## Event architecture

The provider holds no state. Its manifest snapshot enters the event store as a
registry fact; Matching folds the registry materialized view and records
`match.Decided`; the single-writer ResourceActor dispatches realization; and
`normalizeDigitalOceanYardSignal` folds native App Platform and VPC signals into
`yard.*` events. Read stores rebuild from the log, so no snapshot here is
load-bearing. See [`ADR.md`](./ADR.md) for the full command/event walk.

## API surface reached

| Product | Endpoint |
|---|---|
| `digitalocean.app-platform-service/v1`, `…-static-site/v1` | `GET/POST/PUT/DELETE /v2/apps` |
| `digitalocean.managed-{postgres,mysql,mongodb,opensearch,valkey}/v1` | `GET/POST/DELETE /v2/databases`, `PUT /v2/databases/{id}/resize` |
| `digitalocean.droplet/v1` | `GET/POST/DELETE /v2/droplets` |
| `digitalocean.load-balancer/v1` | `GET/POST/PUT/DELETE /v2/load_balancers` |
| `digitalocean.block-storage/v1` | `GET/POST/DELETE /v2/volumes`, `POST …/actions` |
| `digitalocean.kubernetes-cluster/v1` | `GET/POST/DELETE /v2/kubernetes/clusters` |
| `digitalocean.spaces/v1` | `HEAD/PUT/DELETE /{bucket}` on `<region>.digitaloceanspaces.com` (SigV4) |

| `digitalocean.app-platform-worker/v1` | `GET /v2/apps` + `PUT /v2/apps/{id}` (read-modify-write on `spec.workers`) |
| `digitalocean.app-platform-job/v1` | `GET /v2/apps` + `PUT /v2/apps/{id}` (read-modify-write on `spec.jobs`) |

| `digitalocean.functions/v1` | `GET /v2/functions/namespaces/{id}` for the host and credential, then `GET|PUT|DELETE /api/v1/namespaces/{ns}/actions/{name}` on `faas-*.doserverless.co` |

`DIGITALOCEAN_UNRESOLVED_PRODUCT_IDS` is empty.
