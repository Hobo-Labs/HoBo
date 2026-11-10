# @hobo/cloud-providers

One import for every cloud's default Yard.

```ts
import { aws, azure, cloudflare } from "@hobo/cloud-providers";
import { defineStation } from "@hobo/yards";

export default defineStation("acme", {
  yards: [aws.Yard(), azure.Yard(), cloudflare.Yard({ regions: ["weur"] })],
});
```

Each namespace exposes `Yard()` plus that provider's slot factories, so
narrowing a catalog uses the same typed vocabulary the default is built from:

```ts
import { azure } from "@hobo/cloud-providers";
import { defineYard } from "@hobo/yards";

export const prod = defineYard("prod-eu", {
  provider: "azure",
  region: "westeurope",
  web: [azure.containerApps({ ingress: "external" }), azure.aks({ replicas: 3 })],
  data: azure.postgresFlexible({ tier: "GeneralPurpose" }),
});
```

## Why this package exists

A provider package is a layer-2 adapter: it may import `@hobo/core` and nothing
else HoBo. `yard()` lives in `@hobo/yards` at layer 3. So a provider can only
publish its catalog as *data* — `awsYardSpec()` and friends return plain rows,
not a `Yard`. Something above both has to do the parse, and doing it ad hoc at
every call site is how several slightly different spellings of "the default AWS
Yard" get into a codebase. This package is that something, and it decides
nothing: `composeYard` passes the catalog to `yard()` untouched, so canonical
ordering, duplicate rejection, and credential screening remain `@hobo/yards`
refusals with `@hobo/yards` error codes.

## A Yard is a catalog, not an inventory

Rows say what a provider *is able to* allocate ([ADR-0157](../../docs/design/adr/07-portability-extensibility.md#adr-0157)
decision 1). Several entries per capability is the normal case — Azure's `web`
lists Static Web Apps, App Service, Container Apps and AKS — and declaring one
allocates nothing. Selection among them happens at resolution time under
[ADR-0151](../../docs/design/adr/07-portability-extensibility.md#adr-0151)'s
hard gates and lexicographic ranking, never here.

## Parity: how far each namespace is proven

`providerParity()` returns one row per namespace, derived — never typed by
hand — from two live sources: the product ids in the namespace's full
allocatable catalog (`PARITY_SOURCES`; the parsed `Yard().bindings`), and the
provider package's exported `*_RESOLVED_PRODUCT_IDS` constant.
`providerProfileParity()` applies the same derivation per `(provider, profile)`,
ordered by provider then lexicographic profile. `formatParityClaim(row)`
re-derives a row before rendering it, so supplied level or denominator fields
cannot fabricate a claim.

| Level | Meaning | Who may claim it |
|---|---|---|
| `P0` | Catalog only — declarable, no resolver | this package |
| `L1-DECLARED` | At least one resolver id is declared; conformance is not asserted | this package's constants-only projection |
| `L1` | Simulated — a fake-transport resolver **plus** the six lifecycle conformance cases (create/update/replace/delete-idempotent/adopt/crash-resume) **plus** a PACT | conformance evidence (later layers) |
| `L2` | Local-live — the six lifecycle cases against real local processes, loopback only | executed evidence (later layers) |
| `L3` | Local-DX — timed offline script, minutes recorded | executed evidence (later layers) |
| `P2` | Cloud live — **fallback** claim only | cred-gated executed evidence |
| `P3` | Cloud DX — **fallback** claim only | cred-gated executed evidence |

This package can see only constants. It sees that a resolver is *declared*;
it cannot see a conformance run or a pact. It therefore emits `L1-DECLARED`,
not full `L1`, and every rendered claim says "conformance not asserted here".
It never emits `L2`/`L3`/`P2`/`P3`: a higher level printed from static data
would be an overclaim; it needs a run.

How to read a claim — example format, not a current claim:
`acme L1-DECLARED: 1/3 resolvers declared (conformance not asserted here)` means one of
the three product ids acme's catalog declares has a declared resolver, and
nothing here asserts that resolver passes conformance. The denominator is
always present — a level without one is not a claim. Blank provider or product
ids and empty catalogs are refused (`PARITY_PROVIDER_EMPTY`,
`PARITY_PRODUCT_ID_EMPTY`, `PARITY_CATALOG_EMPTY`). A resolved id the catalog
does not declare is refused (`PARITY_RESOLVED_NOT_IN_CATALOG`) rather than
dropped, because dropping it would tidy the denominator.

Grain: provider rows count each **product** once across the whole catalog, so
a product listed under two profiles counts once (AWS's DynamoDB backs both a
document and a key-value profile). Profile rows instead contain only that
profile's catalog ids and the resolved subset. One resolved product makes its
row `L1-DECLARED`; zero makes it `P0`, even when the provider overall is
`L1-DECLARED`. The denominator always says how much is covered.

Vercel is measured against its full allocatable catalog: the bare
`vercel.Yard()` holds the default targets only and omits the opt-in
`project()` row, but `vercel.project/v1` has a shipped resolver, so measuring
against the bare default would refuse with `PARITY_RESOLVED_NOT_IN_CATALOG`.
Vercel's denominator is therefore the default *plus* `project()`. Every other
namespace is measured against its bare `Yard()`.

The current projection, pinned to the code by `test/parity.test.ts` (the test
fails if this block and `providerParity()` disagree):

<!-- parity:begin -->
```text
aws L1-DECLARED: 8/19 resolvers declared (conformance not asserted here)
azure L1-DECLARED: 9/16 resolvers declared (conformance not asserted here)
cloudflare L1-DECLARED: 6/6 resolvers declared (conformance not asserted here)
digitalocean L1-DECLARED: 15/15 resolvers declared (conformance not asserted here)
gcp L1-DECLARED: 9/14 resolvers declared (conformance not asserted here)
hetzner L1-DECLARED: 5/5 resolvers declared (conformance not asserted here)
hostinger L1-DECLARED: 5/5 resolvers declared (conformance not asserted here)
kubernetes L1-DECLARED: 9/9 resolvers declared (conformance not asserted here)
vercel L1-DECLARED: 3/5 resolvers declared (conformance not asserted here)
```
<!-- parity:end -->

Parity is an in-process pure read model: it crosses no integration or
persistence boundary, so it has no protobuf record or CUE wire schema. The
TypeScript row interface therefore duplicates no wire contract. Protobuf-first
applies to the provider-catalog boundary, whose records and constraints remain
in `data-models/`.

## PostgreSQL backend catalog

`POSTGRES_BACKEND_CATALOG` names every PostgreSQL backend HoBo can describe —
Neon, Prisma Postgres, Supabase, pgEdge Cloud, PlanetScale Postgres, Azure
Database for PostgreSQL flexible server, Azure HorizonDB (preview), Amazon RDS
for PostgreSQL, Aurora PostgreSQL, Cloud SQL for PostgreSQL, AlloyDB, and
self-hosted PostgreSQL — as `@hobo/core` `DataStoreCatalogEntry` records. Each
entry answers the same fourteen offering questions (point-in-time restore,
replicas, multi-region, multi-writer, failover, logical replication in and out,
transaction pooler, password and identity-token auth, public CA), and every
answer carries the vendor documentation URL it was read from and the date.

```ts
import { postgresBackendProfiles } from "@hobo/cloud-providers";
import { resolveDataStore } from "@hobo/core";

const resolved = resolveDataStore(postgresBackendProfiles(), {
  features: ["sql.relational", "backup.pitr", "replicate.logical-subscribe"],
  negotiation: "require",
});
```

**This is a catalog of cited claims, not a readiness claim.** Nothing in it has
been provisioned or connected to from this repository. A claim that could not
be confirmed from a primary source is `unknown`, says what is missing, and is
never matched; `postgresBackendEvidence()` reports cited-versus-unknown counts
per entry. No prices or free-tier allowances are recorded. Amazon Aurora DSQL
is recorded in `POSTGRES_BACKEND_EXCLUSIONS` rather than given a provider id,
because it is PostgreSQL-compatible rather than PostgreSQL. The full table, the
naming decision and the sources' date are in
[`docs/design/postgres-backend-catalog.md`](../../docs/design/postgres-backend-catalog.md).

## Self-hosted PostgreSQL: which registered providers could host it

`selfHostedPostgresHosts()` answers from what each provider package declares —
the `compute` classes of its `EQUIVALENCE_CLASSES` and the capability profiles
of its Yard catalog — through `assessSelfHostedDataStore` in `@hobo/core`,
which holds no list of provider names. It assesses the nine parity namespaces
plus Netlify and Railway (equivalence classes only; no Yard catalog here):

| Verdict | Providers | Why |
|---|---|---|
| `can` | `hetzner`, `hostinger` | The declared compute class is a VM. Hetzner also declares an attachable `bucket.filesystem/v1` volume; Hostinger does not, so its data shares the VM's lifetime (reported as a caveat). |
| `cannot` | `cloudflare`, `vercel`, `netlify` | Nothing declared is a VM or a container (edge workers; static and HTTP compute). |
| `undetermined` | `aws`, `azure`, `digitalocean`, `gcp`, `kubernetes`, `railway` | A container is declared, but nothing declares that it is long-running, keeps a disk, accepts TCP, or can run backup tooling. |

A verdict describes the declaration, not the vendor. `undetermined` is resolved
by enriching the provider's declaration with the facet tokens
(`long-running`, `persistent-volume`, `tcp`, `exec`) backed by its
documentation, never by special-casing the provider here.

## HONEST SCOPE

Counts live in the parity block above; this table carries what a count cannot.

| Namespace | Resolver transport | What a deploy does today |
|---|---|---|
| `cloudflare` | Cloudflare API v4 drivers | Drivers are proven against an **injected fake transport**. No live deploy is proven in this repo: that additionally needs real credentials and network egress. |
| `vercel` | Vercel REST drivers | Same: fake-transport proof only. `vercel.blob/v1` and `vercel.edge-function/v1` have no driver — see `VERCEL_UNRESOLVED_PRODUCT_IDS`. |
| `gcp` | Google REST drivers | Same: fake-transport proof only. The rest fail closed. See `GCP_RESOLVED_PRODUCT_IDS` / `GCP_UNRESOLVED_PRODUCT_IDS`. |
| `azure` | ARM drivers | Same: fake-transport proof only. The rest fail closed. See `AZURE_RESOLVED_PRODUCT_IDS` / `AZURE_UNRESOLVED_PRODUCT_IDS`. |
| `aws` | SigV4-signed drivers | Same: fake-transport proof only. The rest fail closed. See `AWS_RESOLVED_PRODUCT_IDS` / `AWS_UNRESOLVED_PRODUCT_IDS`. |
| `digitalocean` | v2 bearer-token drivers, Spaces over SigV4, Functions over OpenWhisk | Same: fake-transport proof only. `queue`, `topic` and `secretRef` carry no rows at all, because DigitalOcean sells none of them. |
| `kubernetes` | apiserver drivers | Same: fake-transport proof only. The Secret's contents arrive through an injected `resolveSecretData` and never through `desired`. This namespace also has a placement driver (`provisionWorkload`), not a resolver, written to place onto a real cluster through an injected transport (opt-in `kubectl proxy`); no live apply is proven here, and the resolvers above remain fake-transport only. Catalog is built-ins only: databases, caches and queues arrive through operators. |
| `hetzner` | Cloud API drivers, Object Storage over SigV4, Storage Box on `api.hetzner.com` | Same: fake-transport proof only. Robot stays unreachable. Five slots carry no rows: Hetzner sells no managed database, cache, queue, topic or secret store. |
| `hostinger` | adopt-and-converge drivers | The odd one out. On Hostinger allocation is a **billing order**, so these resolvers converge an instance you already bought and refuse to purchase one — a refusal the transport guard enforces by not allowlisting `/api/billing/v1/`. Fake-transport proof only. |

Two limits apply to every row above, including namespaces whose whole catalog resolves:

1. **No provider's product ids are registered in the definition catalog.** So even a product with a working resolver refuses at resolution
   today. That is a deliberate fail-closed gap, not a silent one: a deploy
   refuses rather than half-applying.
2. **"Has a resolver" is not "deploys."** Every resolver in this repo is proven
   against an injected fake transport modelling the provider's API. No live
   call has been made against any provider. Pinned API versions and request
   body field names are documentation-derived and have not been verified
   against a running service.

An unresolved product is not always a coverage gap. Some are design limits the
provider's own API imposes — neither `azure.postgres-flexible/v1` nor
`aws.rds-postgres/v1` can ship a resolver, because each one's create call
requires an administrator password in the request body, and a `desired` record
may not carry credential-shaped keys. Others are identity limits:
`aws.api-gateway/v1` mints a fresh random id per call with no name uniqueness,
so a retry after a lost response would create a second API rather than
converge. And some are refusals this repo chose on purpose:
`hostinger.vps/v1` is adopt-only and will not place the billing order that
would allocate one. The
`*_UNRESOLVED_PRODUCT_IDS` declarations carry the reason per id, and distinguish
the two cases.

No catalog enumerates all of its provider. Each declares the offerings that have
typed factories; a missing alternative is a gap in the factory set, not a
selection the Yard made.

## Builder authoring: `station` / `yard` / `camp`

`station`, `yard` and `camp` are re-exported here from `@hobo/yards`
(`buildStation` / `buildYard` / `buildCamp`) so one import line gets both the
noun and the offerings that fill it. They give Station, Yard and Camp the same
shape `bindle()` already has: a name plus a builder callback.

```ts
import { station, yard, camp, azure, cloudflare } from "@hobo/cloud-providers";

export default station("acme", (s) => {
	s.tenant("acme").residency("eu").trustDomain("acme.hobo.internal");

	s.yard(azure, "prod-eu", (y) => {
		y.region("westeurope").residency("eu").label("tier", "public");

		// Slot methods are variadic — several offerings per capability is normal.
		y.web(azure.containerApps({ ingress: "external" }), azure.appService({ sku: "P1v3" }));
		y.data(azure.postgresFlexible({ tier: "GeneralPurpose" }));
		y.bucket(azure.blobStorage({ accessTier: "hot" }));

		// Camps nest inside the Yard, so the Yard's id and provider are already
		// known and never re-supplied by hand.
		y.camp("api", (c) => c.production().label("exposure", "public"));
		y.camp("preview", (c) => c.preview().require("ephemeral").label("ttl", "72h"));
	});

	s.yard(cloudflare.Yard()); // a prebuilt catalog Yard — same method, overloaded
});
```

The rules, and why each one is there:

- **One verb per noun** — `station`, `yard`, `camp`, and `bindle` in
  `@hobo/bindles`. No `define*`, no `attach*`.
- **Nesting replaces attachment.** `y.camp(…)` does what `attachCampToYard` did,
  deriving `yardId` and `providerId` from the enclosing Yard. Handing a Yard
  back its own two identifiers was never information the author had.
- **Callback for containers, chaining for scalars** — the split `bindle()`
  already uses.
- **Slot methods are variadic and accumulate.** One method per `CapabilitySlot`
  (`web api service data kv bucket queue topic secretRef webhook`), installed
  from `CAPABILITY_SLOTS` in `@hobo/core` so the surface cannot drift from the
  vocabulary. `y.web(a)` then `y.web(b)` declares two offerings; silently
  dropping the first would be a portability lie.
- **The provider is an argument, not a builder call.** `yard(azure, "prod-eu", …)`
  establishes it before the callback runs, so there is no window in which slot
  calls are written against a Yard with no provider yet, and moving a line
  cannot change whether the code makes sense. It accepts a namespace object
  (reading its `PROVIDER_ID`), a provider id string, or `{ id }` — and it is
  still stated, never inferred, because inferring one from a Yard name or a
  product-id prefix is the load-bearing naming convention ADR-0144 forbids.
  ES module namespace objects are accepted directly; no plain-object copy is
  needed.
- **No bare strings where a vocabulary exists.** Capability profiles come from
  `capability` in `@hobo/core` (`capability.data.postgres`, not
  `"data.postgres/v1"`) and Camp environments from `ENV_TYPES`. A typo is a
  compile error instead of a row that matches nothing, and `slot: "kv"` will not
  accept a `data.*` profile — the `SLOT_PROFILE_MISMATCH` refusal still exists
  for untyped callers, but typed ones can no longer reach it.
- **Order is not information.** Slots compile in `CAPABILITY_SLOTS` order,
  Camps sort by id, Yards sort by name, and every string list is canonicalized.
  Two builders declaring the same things in different orders are deep-equal.

### It is a front end, not a fork

Every builder terminates in the code that already ships — `defineYard`,
`defineStation`, `camp()` and, through `yard()`, `attachCampToYard`. So
`SLOT_KEY_MISMATCH`, `SLOT_PROFILE_MISMATCH`, `SLOT_BINDING_CREDENTIAL_PROPERTY`,
`YARD_BINDING_DUPLICATE`, `YARD_BINDING_EMPTY_CONSTRAINT`, `STATION_NO_YARDS`,
`STATION_DUPLICATE_YARD`, `camp-provider-selection-forbidden` and
`camp-bindle-ownership-forbidden` all still fire with their existing codes and
messages. `test/builders.test.ts` pins the example above to the `defineStation`
authoring of the same topology, and `packages/yards/test/builder.test.ts` drives
each refusal through the builder path.

### Additive, not a migration

`defineYard`, `defineStation`, `yard()` and `camp()` keep working exactly as
they do now. Nothing needs rewriting.

### Bindle stays in `@hobo/bindles`

`bindle()` is not re-exported here and is not wrapped. App authoring and ops
configuration are different lifecycles with different owners and different
review paths; folding them into one import would make a single surface out of
two unrelated jobs, which is a worse surface, not a better one.

### Known limits

- `station(…)` returns the `StationManifest` that `defineStation` returns — the
  registration record a composition root hands to `station()` in
  `@hobo/stations`. A Station registers Yards; it never parents them
  ([ADR-0131](../../docs/design/adr/07-portability-extensibility.md)).
- The Yard builder has exactly `defineYard`'s expressive range. `require`,
  `prefer`, `isolation`, `network`, `properties`, `runtimeId` and
  `resolverDefaults` are Yard fields `defineYard` does not accept either;
  authoring those still goes through `yard()` directly. Widening the builder
  past its compile target would mean bypassing it.
- `c.provider(…)` and `c.bindle(…)` exist on the Camp builder only to be
  refused, so the two old mistakes get their existing remediation instead of an
  "unknown method".
