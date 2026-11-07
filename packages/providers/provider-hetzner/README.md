# @hobo/provider-hetzner

The Hetzner `CloudProvider`: the Hetzner row of the cross-cloud equivalence
table, a full allocatable Yard catalog, and bearer-token `ResourceResolver`s
for the convergent part of it.

```sh
pnpm --filter @hobo/provider-hetzner test
```

## What this package ships

- **Equivalence → default Resource Definitions** (`EQUIVALENCE_CLASSES` /
  `createHetznerProvider`), with Matching's `satisfies` answering
  full/partial/none rather than fabricating parity.
- **`realize()` → `hobo.iac-program/v1`** for the primary Pulumi lane, with
  bind edges resolving as `${resources.<dep>.outputs.binding}` across a whole
  deployment plan.
- **A typed authoring surface**: `hetzner.with.cloudServer(…)` and friends emit
  provider-specific option blocks that are inert for other providers, and the
  slot factories (`cloudServer()`, `loadBalancer()`, `objectStorage()`,
  `volume()`, …) each own one `(slot, profile, productId)` triple.
- **A default Yard catalog** (`hetznerYardSpec()`): what Hetzner *can* allocate,
  per slot, as canonical rows `@hobo/yards` parses.
- **Direct Cloud API resolvers** (`hetznerResolvers()`): read-or-create
  reconciliation against `api.hetzner.cloud/v1` over an injected, guarded
  transport.
- **The published Capability Manifest**, with declared cost facts and a
  credential-locator auth posture that stores no material.

## Honest scope

- **Hetzner is a narrow provider and this package says so.** There is no
  managed database, cache, queue, topic or secret store here, because Hetzner
  does not sell one. Five Yard slots are empty and the equivalence table has
  two rows, not six. An app that needs Postgres gets a truthful `none` from
  this provider rather than a virtual machine it would have to administer.
- **No live deploy is proven here.** The resolvers are exercised against an
  *injected fake* transport modelling a Hetzner project. A real deploy
  additionally needs a real token, real network egress, and a real project.
- **4 of the 5 catalogued products have resolvers**
  (`HETZNER_RESOLVED_PRODUCT_IDS`): Cloud Servers, Load Balancers, Volumes, and
  Object Storage — the last over SigV4 against its own host and its own key
  pair, under its own guard policy. The fifth is the Storage Box; see below.
- **No Resource Definitions are registered** for the `hetzner.*` product ids,
  so a deploy against this Yard still fails closed at resolution
  (`YARD_BINDING_PRODUCT_UNKNOWN`).
- **Endpoint paths and field names are transcribed** from Hetzner's published
  API reference, not replayed against the running service.
- **Cost facts are `declared-provider`**, transcribed from the public pricing
  page rather than attested by a signed billing feed. Hetzner's monthly price
  cap is a real saving these facts do not model.

## Three surfaces, one allowlisted

Hetzner splits its products across four hosts with three different
credentials, and the transport guard allowlists three of them — each under its
own policy:

| Surface | Host | Credential | Allowlisted |
|---|---|---|---|
| Cloud API | `api.hetzner.cloud/v1` | project API token | **yes** |
| Unified API | `api.hetzner.com/v1` | API token (bearer) | **yes**, under its own policy, `storage_box*` paths only |
| Object Storage | `<location>.your-objectstorage.com` | separate S3 key pair, SigV4 | **yes**, under its own policy |
| Robot | `robot-ws.your-server.de` | HTTP Basic, web console password | no |

Object Storage gets its *own* guard policy rather than riding on the Cloud
API's, which is what makes "a project token cannot reach the S3 origin, and an
S3 key cannot reach the Cloud API" a property of construction rather than of
care. The two credentials are mutually exclusive per resolver: the S3 path
never resolves the project token and the Cloud API path never resolves the S3
keys.

The unified API gets its own policy for the same reason, even though it takes
the same kind of token: a single policy naming both `api.hetzner.cloud` and
`api.hetzner.com` would let a Cloud API path be requested from the unified
origin, and the guard would have nothing to say about it. Its prefix list is
narrower still — `/v1/storage_boxes` and `/v1/storage_box_types` — because that
is all this package uses it for, and a guard that admits only what is used is
the one that makes a later widening visible in review.

An earlier revision of this package excluded the Storage Box, on the grounds
that it was Robot-administered. That was wrong. `GET /v1/storage_boxes` on the
*Cloud* API does answer **404** where `/v1/volumes` answers **401** — but the
right conclusion was that the resource had moved, not that it was unreachable.
It is on the unified host with full CRUD (`GET|POST /v1/storage_boxes`,
`GET|PUT|DELETE /v1/storage_boxes/{id}`) behind an ordinary scoped token, and
`hetzner.storage-box/v1` now ships a resolver like every other product here.

Robot stays excluded, and it is still the sharper case: a resolver reaching it
would be sending the account's *web console password* through an injected
transport, which is a different and much worse thing to hand out than a scoped
token. Nothing this package catalogs needs it. The exclusion is exported as
`HETZNER_EXCLUDED_SURFACES`, so widening the guard is an edit a reviewer sees.

### The Storage Box password

Hetzner requires a password at create time, and a password is material.
`desired` is recorded in the event log, and core refuses credential-shaped keys
in a property bag outright — `password` and `passwordRef` alike — so it does not
travel there at all. It arrives through an injected
`resolveStorageBoxPassword(logicalId)`, the same shape as every other credential
in this repo: the request names the resource, the host decides what secret
belongs to it, and this package holds it no longer than the one call it goes
into. It is in the create body and nowhere else — not an output, not a
diagnostic, not a URL — and that is asserted, not asserted-about.

## Convergence, and what it costs

Persisted `ref.physicalId` selects an exact provider read before mutation or deletion.
A renamed resource cannot be substituted by a same-name replacement. Missing pinned
resources require a new authorized identity rather than an implicit new purchase.

Every read exposes `ready` and `operationConfirmed` from positive provider state;
unknown/provisioning/drifting state remains unconfirmed. Mutation acknowledgements
remain unconfirmed until a later read. A successful DELETE request does not prove
retirement; the durable host keeps observing until the resource is absent.

Cloud Server creation stores `artifactDigest` and `ownershipRef` in native labels.
Each SHA-256 value is split into two 32-character pieces to preserve the full value
within label limits. Read evidence reconstructs it from provider labels, never from
the request. Labels do not establish application health: an independent probe must
verify the served artifact. Explicit non-sensitive `userData` can bootstrap a server.

Static catalog prices are marked `pricingStatus: "estimate"`; production budgets
require current account-scoped bounds. The lifecycle regression suite and actual
`#CostFact` CUE fixtures protect these identity, state and financial boundaries.

Hetzner's collections accept an exact `?name=` filter, so "does my resource
already exist" is one bounded call rather than a paged scan — a nicer property
than most provider APIs offer, and the reason this package needs no page
budget. Three consequences worth stating plainly:

1. **Two records under one name is a refusal, not a coin flip.** Hetzner
   enforces name uniqueness per project, so a second match means the filter did
   not behave as this code believes — a reason to stop, not to pick one.
2. **Provisioning is asynchronous and nothing here polls.** Hetzner answers a
   mutation with an `Action` that is still running; the action id goes into
   `outputs` so a caller who wants to wait has something to wait on, and the
   diagnostic says plainly that this resolver did not.
3. **`"replace"` is never emitted.** Rescaling a server needs a power-off and
   shrinking a volume is impossible, so drift on those is reported as a
   diagnostic and left for a human rather than "fixed" by destroying a machine.

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
`normalizeHetznerYardSignal` folds native server and network signals into
`yard.*` events. Read stores rebuild from the log, so no snapshot here is
load-bearing. See [`ADR.md`](./ADR.md) for the full command/event walk.

## API surface reached

| Product | Endpoint |
|---|---|
| `hetzner.cloud-server/v1` | `GET/POST/DELETE /v1/servers` |
| `hetzner.load-balancer/v1` | `GET/POST/DELETE /v1/load_balancers`, `POST …/actions/change_algorithm` |
| `hetzner.volume/v1` | `GET/POST/DELETE /v1/volumes`, `POST …/actions/resize` |
| `hetzner.object-storage/v1` | `HEAD/PUT/DELETE /{bucket}` on `<location>.your-objectstorage.com` (SigV4) |
