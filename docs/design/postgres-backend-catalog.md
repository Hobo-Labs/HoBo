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
| Self-host matcher (pure) | `@hobo/core` (`ports/self-hosted-data-store.ts`) | `assessSelfHostedDataStore`, `SELF_HOST_FACETS`, `SELF_HOST_FEATURE_TOKENS` |
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

| Provider | Verdict | Reason (derived from its declaration) |
|---|---|---|
| `aws` | undetermined | Fargate declares a container but not long-running-compute, persistent-volume, inbound-tcp, operator-control |
| `azure` | undetermined | Container Apps declares a container but not long-running-compute, persistent-volume, inbound-tcp, operator-control |
| `cloudflare` | cannot | declares compute only as Workers [edge, worker, wasm-native, http]: none is a VM or a container |
| `digitalocean` | undetermined | App Platform declares a container but not long-running-compute, persistent-volume, inbound-tcp, operator-control |
| `gcp` | undetermined | Cloud Run declares a container but not long-running-compute, persistent-volume, inbound-tcp, operator-control |
| `hetzner` | can | on Hetzner Cloud Server |
| `hostinger` | can | on Hostinger VPS. Caveat: no bucket.filesystem/v1 volume is declared: data lives on the VM's own disk and is lost if the machine is rebuilt or deleted |
| `kubernetes` | undetermined | Kubernetes Deployment declares a container but not long-running-compute, persistent-volume, inbound-tcp, operator-control |
| `vercel` | cannot | declares compute only as Vercel Web [http, static, managed]: none is a VM or a container |
| `netlify` | cannot | declares compute only as Netlify Site [http, static, edge, managed]: none is a VM or a container |
| `railway` | undetermined | Railway Service declares a container but not long-running-compute, persistent-volume, inbound-tcp, operator-control |

A verdict is a statement about the **declaration**, not about what the vendor
sells. `cannot` means nothing the provider has registered with HoBo is a VM or
a container. For Vercel that matches the vendor's own guide, which says "You
can't run your own Postgres or Redis container with local disk"
([Docker Compose concepts on Vercel](https://vercel.com/kb/guide/docker-compose-concepts-on-vercel),
read 2026-11-10). `undetermined` means a container is declared but the
declaration is too coarse to say whether it stays up, keeps a disk, or accepts
TCP — the right fix is to enrich that provider's declaration with the facet
tokens, backed by its documentation, not to special-case it here. DigitalOcean
is the clearest case: it sells Droplets and block storage, and both are Yard
rows, but its declared compute class is App Platform, so nothing declares the
Droplet as a VM.

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
