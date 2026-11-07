# @hobo/provider-azure

The Azure `CloudProvider` (HOBO-712): Container Apps, Cosmos DB, Blob
Storage, PostgreSQL Flexible Server, Service Bus, and Cache for Redis behind
HoBo's agnostic ports — the Azure row of the cross-cloud equivalence table
shipped as this provider's default Resource Definitions. This is the cloud
the design's worked example names (`defaultProvider: azure({ region:
"eastus" })`).

| Port | Azure service | Resource class |
|---|---|---|
| `compute` | Container Apps | `azure:container-app` |
| `kv` | Cosmos DB (Table) | `azure:cosmos-table` |
| `objectStore` | Blob Storage | `azure:storage-blob-container` |
| `database` | PostgreSQL Flexible Server | `azure:postgres-flexible-server` |
| `queue` | Service Bus | `azure:servicebus-queue` |
| `cache` | Cache for Redis | `azure:cache-redis` |

- **Factory** `createAzureProvider({ regions })` (HOBO-87 authoring contract).
- **`.with()` builders**: `azure.with.containerApps / postgres / blob /
  cosmos / serviceBus / redis` — typed, additive, inert for non-resolved
  providers.
- **`realize()`** emits a `hobo.iac-program/v1` program for the primary
  Pulumi lane (`stack: azure/<deploymentId>`), with `binding` outputs so bind
  edges resolve across resources.
- **Keyless creds**: the published auth document pins `svid-federation` via
  Entra workload identity federation (HOBO-110) — `staticSecrets: false` is
  parse-enforced.
- **Cost facts**: declared real list-price magnitudes per SKU with monthly
  free-tier facts.
- Installable into the composed registry with `hobo add azure` (held/approve
  semantics per HOBO-710).

## Verification

```sh
pnpm --filter @hobo/provider-azure build
pnpm --filter @hobo/provider-azure test
```

## Default Yard catalog (what Azure *can* allocate)

`azureYardSpec()` and `AZURE_DEFAULT_BINDINGS` (`src/default-yard.ts`) declare
the Azure Yard as an **allocatable catalog**: for each capability slot, every
Azure product that could satisfy it. It is not a mapping, not a pool, and not a
selection — a slot commonly lists several alternatives, and which one an app
gets is decided later by capability selection (ADR-0151) against the
requirements the app states.

| Slot | Declared alternatives |
|---|---|
| `web` | Static Web Apps (`web.static/v1`), App Service, Container Apps, AKS (all `web.hosted/v1`) |
| `api` | API Management (`api.http/v1`) |
| `service` | Functions, Container Apps (`service.worker/v1`) |
| `data` | PostgreSQL Flexible Server (`data.postgres/v1`), SQL Database (`data.relational/v1`), Cosmos DB (`data.document/v1`) |
| `kv` | Cosmos DB Table (`kv.key-value/v1`), Cache for Redis (`kv.redis-compatible/v1`) |
| `bucket` | Blob Storage (`bucket.object/v1`) |
| `queue` | Storage Queue (`queue.at-least-once/v1`), Service Bus queue (`queue.fifo/v1`) |
| `topic` | Service Bus topic (`topic.pubsub/v1`) |
| `secretRef` | Key Vault (`secret-ref.locator/v1`) |

Rows are authored through the typed factories in `src/slots.ts` (one factory
per `(slot, profile, productId)` triple, each with its own options interface).
`azureYardSpec({ regions })` returns raw row-shaped data — `{ provider,
regions, bindings }` — because a provider package is a layer-2 adapter and may
not import `@hobo/yards`; that layer-3 package parses these rows into a
canonical set.

## HONEST SCOPE — catalog only, nothing here deploys

This change ships the **catalog only**. There is no HTTP deployment resolver
for Azure in this package (Cloudflare and Vercel are the two providers with
resolvers today), and the `azure.*` product ids the factories emit are **not
registered** in the definition catalog. A Yard built from this spec declares
what Azure *can* allocate; attempting to deploy against it **fails closed at
resolution** — `YARD_BINDING_PRODUCT_UNKNOWN`, or no registered resolver —
until Resource Definitions and resolvers land. Nothing in this section should
be read as evidence that an Azure deployment works.

## Deployment resolvers (ARM) — supersedes the "catalog only" note above

The section above predates this package's `ResourceResolver` layer and is now
correct only for the products in `AZURE_UNRESOLVED_PRODUCT_IDS`. `src/resolvers.ts`
implements convergent Azure Resource Manager resolvers for **seven** of the
sixteen catalogued `azure.*` product ids, over an injected, guarded
`HttpTransport` (`src/transport.ts`). There is still no IaC engine, no state
file, and no plan/apply round trip.

```ts
import { azureResolverRegistry } from "@hobo/provider-azure";

const registry = azureResolverRegistry({
  subscriptionId: "…-…-…",           // GUID; refused if malformed
  resourceGroup: "hobo-rg",
  resolveCredential: (ref) => host.resolve(ref), // locator in, ARM bearer token out
  pollBudget: 20,                    // long-running-operation polls, bounded
  waitBetweenPolls: (attempt) => host.backoff(attempt), // injected: no clock here
});
```

### Endpoints and pinned api-versions

Every ARM call carries an explicitly pinned `api-version`; `azureArmUrl()` takes
it as a required argument, because ARM refuses a call without one and silently
serializes a *different* resource model for the wrong one.

| Product id | ARM resource id | `api-version` |
|---|---|---|
| `azure.blob-storage/v1` | `…/Microsoft.Storage/storageAccounts/{account}/blobServices/default/containers/{name}` | `2023-05-01` |
| `azure.storage-queue/v1` | `…/Microsoft.Storage/storageAccounts/{account}/queueServices/default/queues/{name}` | `2023-05-01` |
| `azure.service-bus-queue/v1` | `…/Microsoft.ServiceBus/namespaces/{ns}/queues/{name}` | `2021-11-01` |
| `azure.service-bus-topic/v1` | `…/Microsoft.ServiceBus/namespaces/{ns}/topics/{name}` | `2021-11-01` |
| `azure.key-vault/v1` | `…/Microsoft.KeyVault/vaults/{name}` | `2023-07-01` |
| `azure.cosmos-db/v1` | `…/Microsoft.DocumentDB/databaseAccounts/{name}` | `2024-05-15` |
| `azure.cosmos-table/v1` | `…/Microsoft.DocumentDB/databaseAccounts/{account}/tables/{name}` (and its `…/throughputSettings/default`) | `2024-05-15` |
| `azure.cache-for-redis/v1` | `…/Microsoft.Cache/redis/{name}` | `2023-08-01` |
| `azure.container-apps/v1` | `…/Microsoft.App/containerApps/{name}` | `2024-03-01` |

All ids are `/subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}/providers/…`,
and that full id is the `physicalId` every outcome reports — constructed, not
read back, so it is a pure function of (subscription, group, name).

### Parents this package requires but never creates

`azure.blob-storage/v1` and `azure.storage-queue/v1` need `desired.storageAccount`;
`azure.service-bus-queue/v1` and `azure.service-bus-topic/v1` need
`desired.namespace`; `azure.cosmos-table/v1` needs `desired.databaseAccount`;
`azure.container-apps/v1` needs `desired.managedEnvironmentId`.
Each parent is read first and a missing one is a typed refusal naming what to
create. The Cosmos account is additionally checked for the `EnableTable`
capability, because a Table API table cannot exist without it and capabilities
are fixed at account creation — without the check, the table `PUT` fails at ARM
with an error that does not say which of the two resources is wrong. Creating the parent here would mean choosing a globally unique name, a
sku and a region nobody declared — and then owning the deletion question for
every sibling resource inside it.

### Convergence

Every `reconcile()` is read-or-create: `GET` the deterministically named id
(`desired.name`, else `ref.logicalId` — never generated), `PUT` only when
absent, then apply only the mutable deltas. ARM's `PUT` is declarative and
idempotent, which genuinely helps — but *only* because the name is
deterministic, so the second `PUT` addresses the same id as the first. Running
reconcile twice yields the same `physicalId`, one resource, and exactly one
create call. `delete()` treats 404 as success.

`"replace"` is never emitted. Immutable drift — Service Bus `requiresSession`,
duplicate detection, partitioning; Cosmos capacity mode; Key Vault tenant; a
Redis tier or its shard count once clustered; any resource's location; a
Container App's managed environment — is reported as a diagnostic for a human,
because correcting it would mean destroying data.

Two refusals in this group are worth naming because they are bill decisions, not
convergence ones. `azure.cache-for-redis/v1` will not choose a `skuName`: every
Azure Cache tier is billed and they differ by an order of magnitude. It *will*
default `capacity` to 0 — the floor of a tier the caller already chose — and say
so in `diagnostics`. And `azure.cosmos-table/v1` writes a throughput only when
it could read the current one: a `PUT` with nothing to compare against would
repeat on every reconcile, so a declared RU with no readable
`throughputSettings/default` is reported instead of written.

### Long-running operations

Most ARM writes do not finish when the response arrives. This package never
reports a `202` as a completed create. `settleWrite()` handles all three shapes
ARM answers with, and every path is exercised by a test:

- `202` + `Azure-AsyncOperation` → poll the operation document to a terminal
  `status`, then re-read the resource.
- `202` + `Location` → poll the location until it answers with the resource.
- `200`/`201` with a non-terminal `properties.provisioningState` → poll the
  resource itself.
- `200`/`201` with a terminal or absent `provisioningState` → already done (a
  blob container and a Service Bus queue have no provisioning phase at all).

Polling is bounded by the injected `pollBudget` and spaced by the injected
`waitBetweenPolls`; there is no clock read and no unbounded loop. When the
budget runs out with the operation still running, or ARM answers `202` with no
operation header, or the operation URL points off `management.azure.com`, the
outcome carries a diagnostic that says **"accepted but it is NOT confirmed
complete"** — it never reads as done. `delete()` has no diagnostics channel, so
an unconfirmed delete *raises* with the same wording rather than returning.

### Credentials

`credentialRef` is a locator (`env://AZURE_ARM_ACCESS_TOKEN`,
`secret://camp/azure-arm-token`), enforced against the same grammar core's
`parseResolveRequest` uses; a token-shaped value is refused with
`RESOLVER_CREDENTIAL_NOT_A_REF`. The resolved bearer token is written to exactly
one place — the `authorization` request header — and never to a URL, a body, an
output bag, a diagnostic, or a message. ARM error text is redacted
(`redactAzureText`) before it reaches any of those, because ARM echoes request
context that has carried subscription GUIDs and token fragments.

### Products deliberately left unresolved

`AZURE_UNRESOLVED_PRODUCT_IDS` names the seven catalogued ids with no resolver,
and a test asserts the uncovered set is exactly that list. The reasons are on
the declaration in `src/resolvers.ts`; in short: `azure.aks/v1` describes
Kubernetes objects rather than ARM resources; `azure.api-management/v1` is a
30–45 minute operation no deploy-call poll budget can honestly follow;
`azure.postgres-flexible/v1` and `azure.sql-database/v1` need an administrator
login and password in the request body, which a `ResolveRequest` may not carry;
`azure.app-service/v1` and `azure.functions/v1` name no parent plan; and
`azure.static-web-apps/v1` is a coverage gap rather than a design limit — the
ARM surface is convergent, but a Static Web App created without a repository and
repository token is an empty site. A non-convergent resolver is worse than an
absent one, so the absences are declared rather than discovered at deploy time.

### HONEST SCOPE — what is and is not proven

**Proven:** the request and response shapes this package composes and accepts,
against an injected fake transport that models one subscription — convergence
(reconcile twice ⇒ one resource, one `physicalId`, one create call), delete and
delete-when-absent, long-running-operation following *and* the honest
unconfirmed report, redaction of provider error text, refusal of non-locator
credential refs, and the pinned `api-version` on every call.

**Not proven:** nothing here has made a live Azure call. There are no real
credentials, no network egress, no subscription and no resource group behind
these tests. The pinned `api-version` values were written from Azure's published
REST documentation and have **not** been verified against the running service.
The guard constrains the request this package composes and the response it
accepts; it cannot prove the injected transport honours `timeoutMs`, refuses a
302 itself, or terminates TLS against the real ARM certificate. Passing this
package's tests is not evidence that an Azure deployment works.

### Budgeted Container Apps execution

Budgeted execution supplies `ownershipRef` and `artifactDigest`, both complete sha256
references. The resolver persists them as `hobo.owner` / `hobo.artifact` ARM tags and
publishes its observed tag as `outputs.artifactMarker`. `outputs.artifactDigest` is
the independently read container image's immutable OCI digest. Tags do not verify
content. Owned resources
with different or missing ownership are never implicitly adopted. A different artifact
requires a fresh immutable target name. Names must be unique per resource lifetime:
ARM deletion cannot fence a later recreation under a reused name.

`outputs.ready` requires exactly one approved container, no unapproved init containers,
the declared image, CPU, memory, replica bounds and ingress shape,
`provisioningState: Succeeded`, `runningStatus: Running`, and matching
nonempty latest/ready revision names. Explicit CPU, memory, minimum and maximum replica
bounds are required in this mode. A terminal ARM operation alone does not establish
application readiness. Fresh application health remains a separate execution gate.

The resolver guards its own transport and physical/resource identity. A `200` GET
without a resource body is unknown, never absence. Retirement validates ownership and
the source artifact, then requires a scoped absent read after the delete; even `204`
is followed by observation. `test/hosting-lifecycle.test.ts` covers these refusal paths
and capacity drift. Static cost hints are marked `estimate` or `unknown` rather than
being treated as current billing evidence; admission requires scoped bounded quotes.
