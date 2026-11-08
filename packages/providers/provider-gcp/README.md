# @hobo/provider-gcp

The GCP `CloudProvider` (HOBO-713): Cloud Run, Firestore, Cloud Storage,
Cloud SQL PostgreSQL, Pub/Sub, and Memorystore behind HoBo's agnostic ports —
the GCP row of the cross-cloud equivalence table shipped as this provider's
default Resource Definitions. Completes the big-three hyperscaler set behind
one negotiation shape.

| Port | GCP service | Resource class |
|---|---|---|
| `compute` | Cloud Run | `gcp:cloud-run-service` |
| `kv` | Firestore | `gcp:firestore-database` |
| `objectStore` | Cloud Storage | `gcp:gcs-bucket` |
| `database` | Cloud SQL PostgreSQL | `gcp:cloud-sql-postgres` |
| `queue` | Pub/Sub | `gcp:pubsub-topic` |
| `cache` | Memorystore (Redis) | `gcp:memorystore-redis` |

- **Factory** `createGcpProvider({ regions })` (HOBO-87 authoring contract).
- **`.with()` builders**: `gcp.with.cloudRun / cloudSql / gcs / firestore /
  pubsub / memorystore` — typed, additive, inert for non-resolved providers.
- **`realize()`** emits a `hobo.iac-program/v1` program for the primary
  Pulumi lane (`stack: gcp/<deploymentId>`), with `binding` outputs so bind
  edges resolve across resources.
- **Keyless creds**: the published auth document pins `svid-federation` via
  GCP Workload Identity Federation (HOBO-110) — `staticSecrets: false` is
  parse-enforced.
- **Cost facts**: declared real list-price magnitudes per SKU with monthly
  free-tier facts.
- Installable into the composed registry with `hobo add gcp` (held/approve
  semantics per HOBO-710).

## Verification

```sh
pnpm --filter @hobo/provider-gcp build
pnpm --filter @hobo/provider-gcp test
```

## Default Yard catalog (what GCP *can* allocate)

`gcpYardSpec()` and `GCP_DEFAULT_BINDINGS` (`src/default-yard.ts`) declare the
GCP Yard as an **allocatable catalog**: for each capability slot, every Google
Cloud product that could satisfy it. It is not a mapping, not a pool, and not a
selection — a slot commonly lists several alternatives, and which one an app
gets is decided later by capability selection (ADR-0151) against the
requirements the app states.

| Slot | Declared alternatives |
|---|---|
| `web` | Cloud Run, App Engine (`web.hosted/v1`), Cloud Storage site (`web.static/v1`) |
| `api` | API Gateway (`api.http/v1`) |
| `service` | Cloud Functions (`service.worker/v1`), Cloud Run job (`service.batch/v1`) |
| `data` | Cloud SQL for PostgreSQL (`data.postgres/v1`), Cloud SQL for MySQL (`data.mysql/v1`), Firestore (`data.document/v1`) |
| `kv` | Memorystore for Redis (`kv.redis-compatible/v1`) |
| `bucket` | Cloud Storage (`bucket.object/v1`) |
| `queue` | Cloud Tasks (`queue.at-least-once/v1`) |
| `topic` | Pub/Sub (`topic.pubsub/v1`) |
| `secretRef` | Secret Manager (`secret-ref.locator/v1`) |

Rows are authored through the typed factories in `src/slots.ts` (one factory
per `(slot, profile, productId)` triple, each with its own options interface).
`gcpYardSpec({ regions })` returns raw row-shaped data — `{ provider, regions,
bindings }` — because a provider package is a layer-2 adapter and may not
import `@hobo/yards`; that layer-3 package parses these rows into a canonical
set.

## HONEST SCOPE — catalog only, nothing here deploys

This change ships the **catalog only**. There is no HTTP deployment resolver
for GCP in this package (Cloudflare and Vercel are the two providers with
resolvers today), and the `gcp.*` product ids the factories emit are **not
registered** in the definition catalog. A Yard built from this spec declares
what GCP *can* allocate; attempting to deploy against it **fails closed at
resolution** — `YARD_BINDING_PRODUCT_UNKNOWN`, or no registered resolver —
until Resource Definitions and resolvers land. Nothing in this section should
be read as evidence that a GCP deployment works.

## Deployment resolvers (`src/resolvers.ts`, `src/transport.ts`)

The catalog above is no longer the whole story: `gcpResolvers({ projectId,
resolveCredential })` and `gcpResolverRegistry(…)` implement core's
`ResourceResolver` contract for **eight** of the fourteen catalogued products,
calling Google's REST APIs directly over an injected, guarded `HttpTransport` —
no IaC engine, no state file. The six products with no convergent path ship no
resolver at all and are declared in `GCP_UNRESOLVED_PRODUCT_IDS`.

### Endpoints covered

| Product id | Host | Read | Create | Update | Delete |
| --- | --- | --- | --- | --- | --- |
| `gcp.cloud-storage/v1` | `storage.googleapis.com` | `GET /storage/v1/b/{bucket}` | `POST /storage/v1/b?project=` | `PATCH /storage/v1/b/{bucket}` | `DELETE /storage/v1/b/{bucket}` |
| `gcp.pubsub-topic/v1` | `pubsub.googleapis.com` | `GET /v1/projects/{p}/topics/{t}` | `PUT /v1/projects/{p}/topics/{t}` | `PATCH …?updateMask=messageRetentionDuration` | `DELETE /v1/projects/{p}/topics/{t}` |
| `gcp.secret-manager/v1` | `secretmanager.googleapis.com` | `GET /v1/projects/{p}/secrets/{id}` | `POST /v1/projects/{p}/secrets?secretId=` | — (replication is immutable) | `DELETE /v1/projects/{p}/secrets/{id}` |
| `gcp.cloud-tasks/v1` | `cloudtasks.googleapis.com` | `GET /v2/projects/{p}/locations/{l}/queues/{q}` | `POST …/queues` | `PATCH …/queues/{q}?updateMask=` | `DELETE …/queues/{q}` |
| `gcp.cloud-sql-postgres/v1`, `gcp.cloud-sql-mysql/v1` | `sqladmin.googleapis.com` | `GET /v1/projects/{p}/instances/{i}` | `POST /v1/projects/{p}/instances` → Operation | `PATCH …/instances/{i}` → Operation | `DELETE …/instances/{i}` → Operation |
| `gcp.cloud-run/v1` | `run.googleapis.com` | `GET /v2/projects/{p}/locations/{l}/services/{s}` | `POST …/services?serviceId=` → Operation | `PATCH …/services/{s}` → Operation | `DELETE …/services/{s}` → Operation |
| `gcp.cloud-run-job/v1` | `run.googleapis.com` | `GET …/jobs/{j}` | `POST …/jobs?jobId=` → Operation | `PATCH …/jobs/{j}` → Operation | `DELETE …/jobs/{j}` → Operation |
| `gcp.memorystore-redis/v1` | `redis.googleapis.com` | `GET /v1/projects/{p}/locations/{l}/instances/{i}` | `POST …/instances?instanceId=` → Operation | `PATCH …/instances/{i}?updateMask=memorySizeGb` → Operation | `DELETE …/instances/{i}` → Operation |

Operations are polled at `GET /v1/projects/{p}/operations/{op}` (Cloud SQL),
`GET /v2/{operation.name}` (Cloud Run) and `GET /v1/{operation.name}`
(Memorystore).

Memorystore's documented `updateMask` covers `displayName`, `labels`,
`memorySizeGb`, `redisConfig` and `replicaCount`. Of what the binding names,
only `memoryGb` is in that set — `tier` is fixed for the instance's life and a
`redisVersion` move is the separate `upgrade` method, which restarts the node —
so both are reported as drift rather than applied. The size itself is never
guessed: the tier minimum differs (1 GB Basic, 5 GB Standard HA), so a missing
`memoryGb` is a refusal.

**Endpoints deliberately absent** (`GCP_UNRESOLVED_PRODUCT_IDS`):

| Product id | Why there is no resolver |
| --- | --- |
| `gcp.api-gateway/v1` | A gateway needs an `api` + an `apiConfig` + a `gateway`, and an `apiConfig` is immutable — changing the OpenAPI document means minting a *new* config id. `reconcile` would have to invent names to converge. |
| `gcp.app-engine/v1` | A service exists only once a *version* is deployed; versions carry server-assigned ids and the artifact is staged outside this record. There is no deterministically named resource to read before creating. |
| `gcp.cloud-functions/v1` | Deploying requires uploading source to a signed URL minted per call by `generateUploadUrl`. The URL is not deterministic and the source bytes are not in `desired`. |
| `gcp.cloud-storage-site/v1` | The bucket half is convergent, but the product is a *served site*: `cdn: true` also needs a backend bucket, URL map, target proxy and forwarding rule on `compute.googleapis.com`. Shipping the bucket half alone would silently under-deliver the product. |
| `gcp.firestore/v1` | Id, location and mode are fixed at creation, and deletion is gated on an etag plus a delete-protection override this package does not model — only half the lifecycle would be expressible. |

`test/resolvers.test.ts` asserts the set of catalogued products *without* a
resolver is exactly `GCP_UNRESOLVED_PRODUCT_IDS`, so adding a catalog row
without a resolver fails unless the gap is declared.

### Convergence

Every `reconcile()` is read-or-create: GET the deterministically named resource,
create only when it is absent, then apply the mutable deltas. Running it twice
yields the same `physicalId`, one resource and exactly one create call — the
tests assert that per product. `delete()` treats 404 as success, so re-running a
teardown is safe. **`"replace"` is never emitted**: drift on an immutable field
(a bucket's location, a Cloud SQL region or major version, a secret's
replication) is reported as a diagnostic for a human rather than "fixed" by
destroying data.

Pub/Sub, Secret Manager and Cloud Tasks answer a second create with
`409 ALREADY_EXISTS`. That is used as a convergence signal only *after* a GET
missed and only by **re-reading** — a bare create-and-swallow-409 would hide a
real conflict behind a shrug.

### Long-running Operations, handled honestly

Cloud SQL and Cloud Run answer a create with an `Operation` whose `done` is
`false`; the resource is not ready. This package never reads that as a finished
create. It polls the operation to a terminal state through the same injected
transport under a **bounded, injected** budget (`operationPoll: { attempts,
beforeAttempt }` — no clock, no unbounded loop), and when the budget runs out
without a terminal answer the outcome carries `operationConfirmed: false` plus a
diagnostic saying the resource is *not* confirmed ready. An operation that
finishes with an error becomes `RESOLVER_PROVIDER_REJECTED`. A `delete()` that
cannot be confirmed **raises** rather than returning quietly: on that path
silence is the success report and there is no diagnostics channel to qualify it.

### Credentials, transport, errors

`credentialRef` is a **locator**, never material — the same `scheme://…` grammar
core's `parseResolveRequest` enforces. A token-shaped value is refused with
`RESOLVER_CREDENTIAL_NOT_A_REF` and never echoed; the material comes from the
injected `resolveCredential(ref)` and reaches exactly one place, the
`authorization: Bearer …` header. It is never logged, never placed in `outputs`,
and Google's error text is redacted (`redactGcpText`) before it reaches any
message or diagnostic.

Every call goes through core's `guardTransport` with a **per-service** policy
(`gcpTransportPolicy(service)`): HTTPS only, one exact host, one path prefix, no
redirect chasing, 20 s and 512 KiB caps, refuse rather than clamp.
`*.googleapis.com` is deliberately *not* allowlisted — a wildcard would readmit
every Google API at once — and a per-service policy means a Cloud SQL path
cannot be sent to the Cloud Storage host.

### HONEST SCOPE — resolvers

This supersedes the "catalog only" note above for the eight products listed
here, and only for them.

- The resolvers are exercised against an **injected fake transport**. There is
  no live GCP call, no real credential, no network egress and no Google Cloud
  project anywhere in this package's tests. Passing tests prove the request
  shapes, the convergence property and the refusal behaviour — not that a deploy
  works.
- Endpoint paths, request bodies and response field names are written from
  Google's published REST documentation and have **not** been replayed against
  the running services. A field Google has since renamed would fail at deploy
  time, not here.
- Coverage is a slice of each product's API — enough to allocate, observe,
  converge and remove. IAM bindings, Cloud Run traffic splits, Cloud SQL users
  and databases, Pub/Sub subscriptions and Secret Manager *versions* are all out
  of scope; the secret resolver deliberately creates the container only and
  never writes material.
- Whether a matching Resource Definition is registered for these `gcp.*` product
  ids is still checked at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not
  here.

### Budgeted Cloud Run execution

Budgeted execution supplies complete `ownershipRef` and `artifactDigest` sha256 refs.
The resolver writes native `hobo.dev/owner` / `hobo.dev/artifact` annotations and
publishes the observed native artifact annotation as `outputs.artifactMarker`.
`outputs.artifactDigest` is the independently read container image's immutable OCI
digest. An annotation does not verify content.
Foreign project/location/resource/operation IDs, missing ownership and another
artifact's target are refused. A new artifact uses a new immutable target name; source
retirement cannot delete a name now carrying another artifact.

`outputs.ready` requires matching positive observed/current generations, a successful
terminal condition, completed reconciliation, exactly one approved container with the
declared image, and actual CPU, memory, replica/concurrency bounds and ingress.
Budgeted services declare those bounds
explicitly. Quantity comparisons recognize equivalent CPU/memory representations.
A completed operation with a missing post-read remains unconfirmed. Capacity drift
cannot become ready merely because the artifact annotation matches. Updates use an
observed `etag`; retirement verifies an independent absent read after terminal deletion.

`test/hosting-lifecycle.test.ts` covers these observations and negative controls.
Static list-price signals are tagged `estimate`; placeholder zero is `unknown`.
Current bounded quotes and authoritative account usage are supplied independently of
those hints. These modeled-API tests do not replace isolated live-project acceptance.
