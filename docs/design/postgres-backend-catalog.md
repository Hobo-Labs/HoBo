---
type: Reference
title: "PostgreSQL backend catalog and self-hosting"
description: "The catalogue of PostgreSQL backends HoBo can name (managed offerings plus self-hosted), what each realizes with a cited vendor source per claim, and which registered compute providers could host a self-managed PostgreSQL. Cited claims only: nothing here has been provisioned."
tags: [hobo, design, data, postgres, providers, honesty]
---

# PostgreSQL backend catalog and self-hosting

> **Status, stated plainly.** This is a catalog of **cited claims**. No offering
> below has been provisioned, connected to, or exercised from this repository
> by this change. Every claim was read in the vendor's own documentation on
> **2026-11-10** and carries that URL in code; a claim that could not be
> confirmed from a primary source is recorded as **unknown** (`?`) and is never
> matched. Nothing here is live-proven, and
> [`live-provider-matrix.md`](./live-provider-matrix.md) is unchanged on that
> point. No prices and no free-tier allowances are recorded.

## Why this exists

A Postgres port whose backend can move between providers needs two answers
before any mechanism runs: *which backends exist and what does each one
actually give a client*, and *where could we run PostgreSQL ourselves*. Both
are answered here as data, with evidence, so the assignment, replication and
budget-policy mechanism has a vocabulary to negotiate in.

## Where it lives

| Piece | Package | Exports |
|---|---|---|
| Offering and provider vocabulary | `@hobo/core` (`ports/data-store-offerings.ts`) | `DataStoreOfferingId`, `DataStoreProvider`, `DATA_STORE_OFFERING_IDS`, `DATA_STORE_PROVIDERS`, `DATA_STORE_PROVIDER_FAMILIES` |
| Catalog record, parser, profile derivation | `@hobo/core` (`ports/data-store-catalog.ts`) | `parseDataStoreCatalogEntry`, `dataStoreProfileOf`, `operatorOwnedOfferings`, `dataStoreCatalogEvidence` |
| Self-host matcher (pure) | `@hobo/core` (`ports/self-hosted-data-store.ts`) | `assessSelfHostedDataStore`, `parseRegisteredHostForm`, `SELF_HOST_FACETS`, `SELF_HOST_FEATURE_TOKENS` |
| Cited host forms per provider | `@hobo/provider-{aws,azure,gcp,digitalocean,kubernetes,railway}` (`host-forms.ts`) | `AWS_HOST_FORMS`, `AZURE_HOST_FORMS`, `GCP_HOST_FORMS`, `DIGITALOCEAN_HOST_FORMS`, `KUBERNETES_HOST_FORMS`, `RAILWAY_HOST_FORMS` |
| The PostgreSQL catalog (vendor facts) | `@hobo/cloud-providers` (`postgres-backends.ts`) | `POSTGRES_BACKEND_CATALOG`, `postgresBackendProfiles()`, `postgresBackendEvidence()`, `POSTGRES_BACKEND_EXCLUSIONS` |
| Self-host answer from real declarations | `@hobo/cloud-providers` (`self-hosted-postgres.ts`) | `selfHostedPostgresHosts()`, `registeredHostDeclarations()`, `SELF_HOST_PROVIDERS` |

The vocabulary and the parser are core's. The vendor facts are dated
observations that will be refreshed, so they live in a leaf package nothing
depends on: a refresh rebuilds that package alone, not everything downstream of
`@hobo/core`. Provider names stay out of `@hobo/data-postgres`, which remains
the provider-neutral authoring surface. Records are defined in
`packages/core/data-models/data_store_catalog.proto` and
`self_hosted_data_store.proto`, each with CUE constraints beside it.

## Evidence shape

Each claim is `(offering, realization, stability, fidelity, features, detail,
sources[])`, and each source is `{ url, checkedAt, note }` — the same shape
capability profiles use for `sourceRefs`. The parser enforces the discipline: a
claim that asserts anything (`native`, `fallback`, `operator`, `unsupported`)
without a dated `https` source is refused, and an `unknown` claim must say what
could not be confirmed. Realizations:

| Realization | Meaning | Reaches the profile as |
|---|---|---|
| `native` | The product does this itself; cited. | a native offering |
| `fallback` | Not native; HoBo realizes it on top of the store. | the fallback ladder |
| `operator` | Not provided; whoever runs the store builds and runs it. | the fallback ladder, first |
| `unsupported` (`no`) | The vendor's documentation says it is not offered; cited. | nothing |
| `unknown` (`?`) | Not confirmed from a primary source. | nothing (fails closed) |

`stabilityBasis` separates a status the vendor states in as many words
(`vendor-stated`: a GA announcement, a "(Preview)" title, a feature-status
table) from one read off the absence of a preview marker (`inferred`).

## The catalog

Generated from `POSTGRES_BACKEND_CATALOG`; the per-claim source URLs and notes
are in `packages/cloud-providers/src/postgres-backends.ts`.

| Offering (`DataStoreProvider`) | Stability (basis) | Password | Identity token | Transaction pooler | Public CA | Logical in (subscribe) | Logical out (publish) | PITR | Read replica | Multi-region | Multi-writer | Failover | Cited / unknown |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Neon Postgres (`neon-postgres`) | stable (inferred) | native | ? | native | native | native | native | native | native | no | ? | ? | 11 / 3 |
| Prisma Postgres (`prisma-postgres`) | stable (vendor-stated) | native | ? | native | ? | ? | ? | no | ? | ? | ? | ? | 5 / 9 |
| Supabase Postgres (`supabase-postgres`) | stable (vendor-stated) | native | ? | native | no | ? | native | native | native | native | ? | native (experimental) | 11 / 3 |
| pgEdge Distributed PostgreSQL: Cloud Edition (`pgedge-cloud`) | stable (inferred) | ? | ? | ? | ? | ? | ? | ? | ? | native | native | ? | 4 / 10 |
| PlanetScale Postgres (`planetscale-postgres`) | stable (vendor-stated) | native | ? | native | native | native | native | native | native | ? | ? | native | 11 / 3 |
| Azure Database for PostgreSQL flexible server (`azure-postgres-flexible`) | stable (inferred) | native | native | native | native | native | native | native | native | native | no | native | 14 / 0 |
| Azure HorizonDB (`azure-horizondb`) | preview (vendor-stated) | native | ? | no | ? | ? | ? | native | native | no | ? | native | 8 / 6 |
| Amazon RDS for PostgreSQL (`aws-rds-postgres`) | stable (inferred) | native | native | native | no | native | native | native | native | ? | ? | native | 12 / 2 |
| Amazon Aurora PostgreSQL-Compatible Edition (`aws-aurora-postgres`) | stable (inferred) | native | native | native | no | ? | native | native | native | native | no | native | 13 / 1 |
| Cloud SQL for PostgreSQL (`gcp-cloudsql-postgres`) | stable (inferred) | native | native | native | ? | native | native | native | native | native | ? | native | 12 / 2 |
| AlloyDB for PostgreSQL (`gcp-alloydb`) | stable (inferred) | native | native | native | ? | ? | ? | native | native | native | ? | native | 9 / 5 |
| PostgreSQL, self-managed on registered compute (`self-hosted-postgres`) | stable (inferred) | native | ? | operator | operator | native | native | operator | operator | operator | no | operator | 13 / 1 |

Reading the table: **Password** is a static role password in the connection
string (`auth.password`); **Identity token** is a short-lived identity token
used as the password — AWS IAM, Google Cloud IAM, Microsoft Entra
(`auth.identity-token`); **Public CA** means the server certificate verifies
against a public root, so a client needs no provider CA bundle
(`tls.public-ca`; `no` means the provider's own root); **Logical in / out** is
logical replication as a subscriber / as a publisher. Azure HorizonDB is
**preview** in Microsoft's own words (checked 2026-11-10), so every native
offering of it resolves as `preview`. Supabase's failover is `experimental`
because its high-availability option is a Private Alpha.

### How the pooled endpoint differs from the direct one

| Offering | Transaction-pooler endpoint versus direct |
|---|---|
| `neon-postgres` | pooled endpoint is the same hostname with -pooler appended to the endpoint id; the unsuffixed hostname is direct |
| `prisma-postgres` | pooled and direct endpoints differ by hostname only (pooled.db.prisma.io vs db.prisma.io), same port 5432 and credentials |
| `supabase-postgres` | transaction mode is port 6543 (shared pooler host, or the project host on paid plans); port 5432 is session mode on the pooler host and direct on the project host |
| `planetscale-postgres` | pooled and direct endpoints differ by port on the same host: 6432 is PgBouncer, 5432 is direct |
| `azure-postgres-flexible` | pooled and direct endpoints differ by port on the same host: 6432 is PgBouncer, 5432 is direct; not on the Burstable tier; opt-in per server |
| `azure-horizondb` | Not offered. the vendor suggests an external pooler until built-in pooling ships |
| `aws-rds-postgres` | RDS Proxy is a separate resource with its own endpoint hostname; the DB instance endpoint is direct. Pinned sessions are not multiplexed |
| `aws-aurora-postgres` | RDS Proxy is a separate resource with its own endpoint hostname; cluster endpoints are direct |
| `gcp-cloudsql-postgres` | pooled and direct endpoints differ by port: 6432 is Managed Connection Pooling, 5432 is direct |
| `gcp-alloydb` | pooled and direct endpoints differ by port: 6432 is managed connection pooling; session mode is also selectable |
| `self-hosted-postgres` | a pooler is separate software the operator runs; its endpoint is whatever port the operator binds |

### What a realistic request resolves to

The relay's request — relational, transactions, point-in-time restore, and a
standby that can be kept current (`sql.relational`, `sql.transactions`,
`backup.pitr`, `replicate.logical-subscribe`, negotiation `require`) —
resolves, per `packages/cloud-providers/test/postgres-backends.test.ts`:

- **Fully native:** `neon-postgres`, `planetscale-postgres`,
  `azure-postgres-flexible`, `aws-rds-postgres`, `gcp-cloudsql-postgres`.
- **Partial, with PITR on the operator's side:** `self-hosted-postgres`
  (`fallbacks: ["backup.pitr"]`).
- **Refused (fail closed):** `prisma-postgres` (PITR is announced, not
  available, and inbound replication is unknown), `supabase-postgres`,
  `aws-aurora-postgres`, `azure-horizondb`, `gcp-alloydb` (inbound logical
  replication not confirmed), `pgedge-cloud` (both unknown). A refusal here
  means *not confirmed from a primary source*, not *the vendor cannot*.

## Naming decision

Provider ids come in two grains, and both stay valid:

- **Family ids** — `aws-rds`, `gcp-cloudsql`, `azure-sql` — are the original
  engine-agnostic ids. They parse exactly as before and are not removed.
- **Product ids** — `<vendor>-<product>`, one PostgreSQL product each. They are
  added *alongside* the family ids rather than replacing them, because the
  facts a connection port needs differ per product inside one family: RDS for
  PostgreSQL and Aurora PostgreSQL are both "AWS" and differ on replicas,
  multi-region and endpoints; `azure-sql` is SQL Server and says nothing about
  Azure Database for PostgreSQL. `DATA_STORE_PROVIDER_FAMILIES` maps a product
  id to the family it refines (`aws-rds-postgres` → `aws-rds`,
  `gcp-cloudsql-postgres` → `gcp-cloudsql`).

`supabase-postgres` already had the product shape and is kept. New offering ids
follow the existing `<area>.<specific>` shape: `replica.multi-region`,
`write.multi-writer`, `ha.failover`, `replicate.logical-publish`,
`replicate.logical-subscribe`, `pool.transaction`, `auth.password`,
`auth.identity-token`, `tls.public-ca`. They were added rather than overloading
`replica.read` or `cdc.stream`: a standby policy has to require *inbound*
replication specifically, and a connection port has to require an auth mode.

**Aurora DSQL is deliberately not a provider id.** It is PostgreSQL-compatible,
not PostgreSQL: AWS's own guidance moves trigger logic into the application,
and its authentication uses expiring tokens. A request against this catalog
assumes real PostgreSQL behaviour, so DSQL is recorded in
`POSTGRES_BACKEND_EXCLUSIONS` with its sources instead of being matchable.

## Self-hosted PostgreSQL on registered compute

`self-hosted-postgres` is a catalog entry like any other, and its claims say
what the operator then owns that a managed service would provide. In the same
vocabulary: `backup.pitr`, `replica.read`, `replica.multi-region`,
`ha.failover`, `pool.transaction` and `tls.public-ca` are **operator**
realizations — PostgreSQL can do them, somebody has to build, run and rehearse
them. Version upgrades and patching are the operator's too; they are not an
offering id because nothing negotiates on them.

Hosting it needs four things: a long-running container or VM; a volume or disk
that survives restarts and redeploys; inbound TCP on a private or public
address (not HTTP-only ingress); enough control to run backups.
`assessSelfHostedDataStore` derives the answer from what each provider package
already declares — the `compute` classes of its `EQUIVALENCE_CLASSES` (the
table its Capability Manifest publishes) and the capability profiles of its
Yard catalog — and contains no list of provider names:

- a compute class declaring `vm` establishes all four (a VM is a machine the
  operator owns); a `bucket.filesystem/v1` Yard row additionally shows a volume
  that outlives the machine;
- a compute class declaring `container` establishes nothing by itself: each
  facet needs its own token (`long-running`, `persistent-volume`, `tcp`,
  `exec`), and a volume elsewhere in the catalog does not show the container
  can mount it;
- anything else is not a host form.

Tokens alone cannot say which of a provider's products fits, so a provider
package can also publish **host forms** (`*_HOST_FORMS`, parsed by
`parseRegisteredHostForm`): one compute product it *already declares* — a Yard
`productId`, or an equivalence `resourceClass` — stated to be a VM or a
container, with each facet it provides or lacks cited to the vendor's
documentation in the catalog's `{ url, checkedAt, note }` shape. A form adds no
product and leaves the published Capability Manifest untouched; it names the
Yard `bucket.filesystem/v1` product that realizes its volume when the catalog
has one. Forms are assessed per product, so a provider can have one form that
can and one that cannot, and `SelfHostAssessment.forms` lists both.

| Provider | Verdict | Qualifying form | Other forms assessed | Reason or caveat |
|---|---|---|---|---|
| `aws` | can | `aws.ecs-service/v1` (Amazon ECS service on Fargate) | `aws.app-runner/v1` cannot | the persistent volume is cited from vendor documentation, but no bucket.filesystem/v1 product in this provider's Yard catalog realizes it yet |
| `azure` | can | `azure.container-apps/v1` (Azure Container Apps) | — | the persistent volume is cited from vendor documentation, but no bucket.filesystem/v1 product in this provider's Yard catalog realizes it yet |
| `cloudflare` | cannot | — | — | declares compute only as Workers [edge, worker, wasm-native, http]: none is a VM or a container |
| `digitalocean` | can | `digitalocean.droplet/v1` (DigitalOcean Droplet) | `digitalocean.app-platform-service/v1` cannot | every facet established |
| `gcp` | undetermined | — | `gcp.cloud-run/v1` undetermined | Cloud Run service declares a container but not long-running-compute, inbound-tcp, operator-control |
| `hetzner` | can | `hetzner:cloud-server` (Hetzner Cloud Server) | — | every facet established |
| `hostinger` | can | `hostinger:vps` (Hostinger VPS) | — | no bucket.filesystem/v1 volume is declared: data lives on the VM's own disk and is lost if the machine is rebuilt or deleted |
| `kubernetes` | can | `kubernetes.statefulset/v1` (Kubernetes StatefulSet) | `kubernetes:deployment` undetermined | every facet established |
| `vercel` | cannot | — | — | declares compute only as Vercel Web [http, static, managed]: none is a VM or a container |
| `netlify` | cannot | — | — | declares compute only as Netlify Site [http, static, edge, managed]: none is a VM or a container |
| `railway` | can | `railway:service` (Railway persistent service) | — | the persistent volume is cited from vendor documentation, but no bucket.filesystem/v1 product in this provider's Yard catalog realizes it yet |

A verdict is a statement about the **declaration**, not about what the vendor
sells. `cannot` at provider level means nothing the provider has registered
with HoBo is a VM or a container. For Vercel that matches the vendor's own
guide, which says "You can't run your own Postgres or Redis container with
local disk"
([Docker Compose concepts on Vercel](https://vercel.com/kb/guide/docker-compose-concepts-on-vercel),
read 2026-11-10).

Reading the `can` rows honestly:

- **DigitalOcean and Kubernetes** qualify on products and volumes that are
  both in their Yard catalogs (Droplet + Block Storage; StatefulSet +
  PersistentVolumeClaim). The matcher reads those rows; the host form only
  states what kind of product each is.
- **AWS, Azure and Railway** qualify on a container product whose persistent
  volume is cited from documentation but is **not a product in that provider's
  Yard catalog** (Amazon EFS, Azure Files, Railway volumes), so HoBo cannot
  allocate it yet; that is the caveat on the row. EFS and Azure Files are
  network file shares, not block storage, and their fitness for a database's
  durability semantics is not assessed here.
- **GCP stays undetermined.** Its Yard declares Cloud Run, App Engine and
  functions, and no VM, Kubernetes or volume product. For Cloud Run only the
  volume facet could be cited (NFS mounts); the pages read did not settle
  whether a Cloud Run service accepts raw inbound TCP, so nothing is claimed.
  Resolving it means either reading that question to a primary source or
  adding a VM or Kubernetes product to the GCP Yard.
- **App Runner and App Platform** are `cannot` per product, each on one cited
  facet (HTTP-only ingress; no persistent storage).

Nothing has been deployed onto any of these products from this repository.

### Citations per host-form facet (read 2026-11-10)

| Provider form | Facet | Holds | Cited statement | Source |
|---|---|---|---|---|
| `aws.ecs-service/v1` | is a container | yes | an ECS service keeps a desired number of tasks running | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html> |
| `aws.ecs-service/v1` | long-running-compute | yes | 'This helps maintain your desired number of tasks in the service' | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html> |
| `aws.ecs-service/v1` | persistent-volume | yes | 'your tasks have access to the same persistent storage'; on Fargate, EFS is supported on platform version 1.4.0 or later | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html> |
| `aws.ecs-service/v1` | inbound-tcp | yes | the Network Load Balancer 'attempts to open a TCP connection to the selected target on the port specified in the listener configuration' | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/nlb.html> |
| `aws.ecs-service/v1` | operator-control | yes | 'You can use ECS Exec to run commands in or get a shell to a container running on an Amazon EC2 instance or on AWS Fargate' | <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html> |
| `aws.app-runner/v1` | is a container | yes | App Runner runs container instances behind web requests | <https://docs.aws.amazon.com/apprunner/latest/dg/develop.html> |
| `aws.app-runner/v1` | inbound-tcp | **no** | 'App Runner provides support for HTTP 1.0 and HTTP 1.1 to the container instances' | <https://docs.aws.amazon.com/apprunner/latest/dg/develop.html> |
| `azure.container-apps/v1` | is a container | yes | Container Apps runs containers with managed ingress | <https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview> |
| `azure.container-apps/v1` | long-running-compute | yes | 'If you want to ensure that an instance of your revision is always running, set the minimum number of replicas to 1 or higher' | <https://learn.microsoft.com/en-us/azure/container-apps/scale-app> |
| `azure.container-apps/v1` | persistent-volume | yes | storage types table: 'Azure Files | Permanent storage | Data is persisted to Azure Files'; container-scoped storage is ephemeral | <https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts> |
| `azure.container-apps/v1` | inbound-tcp | yes | 'Ingress supports: External and internal ingress; HTTP and TCP ingress types' | <https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview> |
| `azure.container-apps/v1` | operator-control | yes | 'Connecting to a container's console is useful when you want to troubleshoot your application inside a container' | <https://learn.microsoft.com/en-us/azure/container-apps/container-console> |
| `digitalocean.droplet/v1` | is a vm | yes | 'DigitalOcean Droplets are Linux-based virtual machines (VMs) that run on top of virtualized hardware' | <https://docs.digitalocean.com/products/droplets/> |
| `digitalocean.droplet/v1` | persistent-volume | yes | 'Volumes are network-attached block storage' | <https://docs.digitalocean.com/products/volumes/> |
| `digitalocean.app-platform-service/v1` | is a container | yes | App Platform runs containers on host instances it manages | <https://docs.digitalocean.com/products/app-platform/details/limits/> |
| `digitalocean.app-platform-service/v1` | persistent-volume | **no** | 'The host instances running App Platform containers do not provide persistent data storage' | <https://docs.digitalocean.com/products/app-platform/details/limits/> |
| `gcp.cloud-run/v1` | is a container | yes | 'A Cloud Run service starts Cloud Run instances to handle incoming requests' | <https://cloud.google.com/run/docs/container-contract> |
| `gcp.cloud-run/v1` | persistent-volume | yes | 'To mount an NFS server as a volume in Cloud Run'; 'we recommend Filestore, which is a fully managed NFS offering' | <https://cloud.google.com/run/docs/configuring/services/nfs-volume-mounts> |
| `kubernetes.statefulset/v1` | is a container | yes | a StatefulSet manages Pods 'that need persistent storage or a stable, unique network identity' | <https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/> |
| `kubernetes.statefulset/v1` | long-running-compute | yes | 'useful for managing applications that need persistent storage or a stable, unique network identity' | <https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/> |
| `kubernetes.statefulset/v1` | persistent-volume | yes | StatefulSets provide 'Stable, persistent storage' | <https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/> |
| `kubernetes.statefulset/v1` | inbound-tcp | yes | 'The default protocol for Services is TCP' | <https://kubernetes.io/docs/concepts/services-networking/service/> |
| `kubernetes.statefulset/v1` | operator-control | yes | 'how to use kubectl exec to get a shell to a running container' | <https://kubernetes.io/docs/tasks/debug/debug-application/get-shell-running-container/> |
| `railway:service` | is a container | yes | 'Persistent services: Services that are always running' | <https://docs.railway.com/reference/services> |
| `railway:service` | long-running-compute | yes | 'Persistent services: Services that are always running' | <https://docs.railway.com/reference/services> |
| `railway:service` | persistent-volume | yes | 'When mounting a volume to a service, a volume is made available to the service on the specified mount path' | <https://docs.railway.com/reference/volumes> |
| `railway:service` | inbound-tcp | yes | TCP Proxy 'is useful for services like databases, game servers, or any application that communicates over raw TCP' | <https://docs.railway.com/reference/tcp-proxy> |
| `railway:service` | operator-control | yes | 'When a volume is mounted to a service, backups can be manually created, deleted and restored'; schedules daily, weekly or monthly | <https://docs.railway.com/reference/backups> |

The table covers the nine provider namespaces with a Yard catalog plus Netlify
and Railway, which publish compute equivalence classes but no Yard catalog in
`@hobo/cloud-providers`, so their catalog half is empty. Neon, Prisma Postgres,
Upstash and Convex are data backends, not compute, and are not hosts.

## Gates

TypeScript (`@hobo/core`, `@hobo/cloud-providers`); protobuf
(`data_store_catalog.proto`, `self_hosted_data_store.proto`, generated into
`packages/core/src/_generated`); CUE beside each proto, including the
dependent rule that only an `unknown` claim may be unsourced. Tests:
`packages/core/test/data-store-offerings.test.ts`,
`data-store-catalog.test.ts`, `self-hosted-data-store.test.ts`, and
`packages/cloud-providers/test/postgres-backends.test.ts`,
`self-hosted-postgres.test.ts`. There is no service boundary here, so no PACT:
this is in-process vocabulary and a read model.

## Not done

- No offering is provisioned, connected to, or conformance-tested.
- No prices or allowances; ranking input belongs in `@hobo/pricing`.
- The catalog is one central file. Declaring each product in its own provider
  package, as traffic-routing profiles are, is the natural next step once every
  vendor has one.
- Unknown cells stay unknown until someone reads the primary source.
