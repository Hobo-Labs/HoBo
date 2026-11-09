# @hobo/provider-cloudflare

The first concrete HoBo `CloudProvider` (S2-06). It maps provider-neutral
resource plans onto Cloudflare's edge platform and publishes a machine-readable
Capability Manifest.

## Scope (in)

- Initial capability ports: **compute / web-service** (Workers), **kv** (KV),
  **objectStore** (R2)
- Equivalence-class mappings per port (`cloudflare:workers-script`,
  `cloudflare:kv-namespace`, `cloudflare:r2-bucket`)
- `CLOUDFLARE_TRAFFIC_ROUTING_PROFILE` — declared TrafficRouting offerings
  (`lb.lifecycle`, `lb.weighted`, `lb.health`, `observe.health`) for Matching
- `createCloudflareProvider()` implementing the `CloudProvider` contract:
  `id`, `regions`, `capabilities`, `realize(plan)`, `capabilityManifest()`,
  `client(port, outputs)`
- `realize(plan)` emits a Pulumi `IacProgram` (the exact shape
  `@hobo/iac-pulumi.validateIacProgram()` accepts) plus an optional `BuildSpec`
- Typed `cloudflare.with.worker/r2/kv` option builders
- Published Capability Manifest (`capabilities.json`, `auth.json`, `cost.json`)

## Scope (out)

- Live Terraform apply against permanent Cloudflare accounts — `realize`
  emits programs, it does not apply them (temporary Environment Stations are
  the exception below)
- The Planner (S2-02) and Yard (S2-01)
- D1, Queues, DNS, Hyperdrive

## Temporary Environment Stations (in scope)

Anonymous visitors need a real Cloudflare Environment Station without OAuth.
Cloudflare Temporary Accounts ([claim deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/))
are the **only** auth model — **no** permanent `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` for this path.

| Path | When | API |
|---|---|---|
| `provisionTemporaryEnvironmentStation()` | Agents / Node backends | REST `provisioning/previews` + PoW + Workers script upload |
| `deployTemporaryWithWrangler()` | Agents / CLI | `wrangler deploy --temporary` (Wrangler ≥ 4.102, **logged out**) |
| `bootstrapCorsRelayViaTemporaryAccounts()` | Fix browser CORS | Deploys CORS relay Worker via Temporary Accounts |
| CORS relay `POST /station` | Examples static site | Browser → relay `workers.dev` → Temporary Accounts (Worker→CF has no CORS) |

Browser cannot read `api.cloudflare.com` Temporary Accounts responses (no ACAO).

## `cloudflare.temporary-account-yard/v1` — the claimable edge Yard

`provisionTemporaryAccountYard()` is the capability-profile-aware path (the
older `provisionTemporaryEnvironmentStation()` above still deploys a Station and
is unchanged). It runs entirely server-side through an **injected**
`TemporaryAccountTransportPort` — there is no reference to the global `fetch` in
`src/temporary-account*.ts` — and it enforces, in this order:

1. **Consent first.** `parseConsentEvidence()` requires an opaque subject
   reference plus acceptance of Cloudflare's exact Terms and Privacy URLs, and
   the evidence is written to a `ConsentLedgerPort` **before** the first
   provisioning request. A missing acceptance fails closed with
   `CONSENT_REQUIRED` and no request is sent.
2. **Bounded proof of work.** The challenge is refused above `k * g = 64,000,000`
   (Cloudflare's own bound) or a lower caller budget (`WORK_BUDGET_EXCEEDED`).
3. **Custody.** `account.apiToken` goes straight into a `SecretCustodyPort` and
   is returned only as a `SecretRef`. No returned value, event, or receipt
   contains it; a custody failure is `SECRET_CUSTODY_UNAVAILABLE`.
4. **One-time claim action.** `claim.url` is a bearer credential, so it is stored
   in a `OneTimeActionVaultPort` and surfaced as an opaque
   `SensitiveActionRef` (`hobo-action:cloudflare.claim-deployment:…`).
   `redeemClaimAction()` discloses the URL once, to the audience it was minted
   for, before the recorded deadline.
5. **Lease from the response.** `GuestLease` records `account.expiresAt` and
   `claim.expiresAt` **as returned by Cloudflare**. The documented 60-minute
   window is carried alongside as documentation
   (`documentedClaimWindowMinutes` + source URL + checked date), never as the
   authority for an expiry decision.

After the claim, `completeTemporaryAccountClaim()` verifies ownership through an
independent `ClaimVerificationPort`, destroys the residual token and claim
action, and refuses to finish while the provider still reports the bootstrap
token as active (`BOOTSTRAP_AUTHORITY_REMAINS`). Continuing HoBo/agent
management is a **separate ceremony**: `creatorAuthorityAfterClaim` is
`"reauthorization-required"` and `assertManagementAuthorized()` throws
`REAUTHORIZATION_REQUIRED` without a fresh grant.

Ambiguous outcomes are never blind-retried. A lost mutating response raises
`PROVIDER_OPERATION_AMBIGUOUS`; the recorded attempt is resolved with
`observeAndAdoptTemporaryAccount()`, which adopts what actually exists or
reports `not-created`.

### Verified supported resources and limits

Source: [Claim deployments (temporary accounts)](https://developers.cloudflare.com/workers/platform/claim-deployments/)
— doc "Last updated Jul 14, 2026", re-read **2026-08-08**. `assertTemporaryAccountResourceAllowed()`
fails closed on everything outside this table.

| Resource | Documented capability or limit | Verified |
|---|---|---|
| Workers | Deployments on `workers.dev` (no custom domain until claimed) | yes |
| Workers Static Assets | Up to 1,000 files, each asset up to 5 MiB | yes |
| Workers KV | Namespace create/list/rename/delete; key put/get/list/delete; bulk put/get/delete | yes |
| D1 | One database, up to 100 MB per database and 100 MB total | yes |
| Durable Objects | Workers with Durable Object bindings and migrations | yes |
| Hyperdrive | Up to 2 database configurations and 10 connections | yes |
| Queues | Up to 10 queues | yes |
| mTLS and CA certificates | `wrangler cert` upload, list, delete | yes |

Numbers are stored in the doc's own units (`mebibytes`, `megabytes`, `count`,
`connections`) rather than re-derived into bytes, because "100 MB" is not a
byte count Cloudflare committed to.

Corroborated independently: wrangler registers `--temporary` only on the
commands the preview token can serve — Workers, KV, D1, Hyperdrive, Queues, and
certificate commands — with "Pages/R2/AI/etc. aren't" stated in the same change
([cloudflare/workers-sdk 1664d46](https://github.com/cloudflare/workers-sdk/commit/1664d4687e04e0cfb350fd931498eb59ac324f06),
read 2026-08-08).

**Explicitly refused** — absent from that table on the checked date, so refused
with `RESOURCE_NOT_SUPPORTED` until both current docs and a conformance run say
otherwise: **R2**, **Containers**, **Vectorize**, **Workers AI**, **Secrets
Store**, **Cron Triggers**, and custom domains. Cron Triggers matter for
capability honesty: no temporary-account product claims
`service.scheduled/v1`.

### Documentation and native acceptance evidence

| Verified 2026-08-08 | Not verified |
|---|---|
| The supported-resources table above, verbatim | The REST **paths** (`/client/v4/provisioning/previews`, `…/previews/challenge`) |
| The 60-minute claim window, and that opening the claim URL is not itself enough | The request/response **JSON field names** (`account.id`, `account.apiToken`, `claim.url`, …) |
| Proof-of-work required before account creation; rate-limited creation | The proof-of-work challenge **wire shape** |
| Terms of Service and Privacy Policy must be accepted in the product | |
| REST provisioning exists ([changelog, 2026-07-14](https://developers.cloudflare.com/changelog/post/2026-07-14-temporary-accounts-api/)) | |

The table records the original documentation review. Anonymous native acceptance
on **2026-10-30** subsequently exercised the preview challenge and provisioning
wire contract, then the generic Worker resolver's upload, source readback,
Workers.dev activation, HTTP response and deletion. That acceptance covers this
Worker path, not every temporary-account resource. `parsePreviewAccountResponse()`
and `parsePreviewChallengeResponse()` still require their bounded exact shapes
and refuse drift with `PROVIDER_CONTRACT_CHANGED`.

### Product definitions

`CLOUDFLARE_TEMPORARY_ACCOUNT_DEFINITIONS` are pure `SelectionCandidate` data
consumed by `@hobo/capability-profiles`:

| Definition | Capability profiles |
|---|---|
| `cloudflare.temporary-workers-web/v1` | `web.static/v1`, `web.hosted/v1` |
| `cloudflare.temporary-workers-api/v1` | `api.http/v1` |
| `cloudflare.temporary-queue-consumer/v1` | `service.queue-consumer/v1` |
| `cloudflare.temporary-d1/v1` | `data.sqlite/v1`, `data.relational/v1` — **never** `data.postgres/v1` |
| `cloudflare.temporary-kv/v1` | `kv.key-value/v1` |
| `cloudflare.temporary-durable-object/v1` | `kv.durable-object/v1`, `realtime.websocket/v1` |
| `cloudflare.temporary-queue/v1` | `queue.at-least-once/v1` |
| `cloudflare.temporary-hyperdrive/v1` | none — connectivity only, produces `binding.postgresql/v1` |
| `cloudflare.temporary-webhook-realtime/v1` | `webhook.inbound-http/v1`, `realtime.websocket/v1` |

D1 speaks SQLite, so a `data.postgres/v1` requirement must lose it to a real
PostgreSQL product; `test/temporary-account-definitions.test.ts` pins that
through `selectCapabilityImplementation`. Hyperdrive is connectivity to somebody
else's database and therefore satisfies no `data.*` requirement at all.

### Stable error codes

`PROVIDER_RATE_LIMITED`, `PROVIDER_AUTH_FAILED`, `PROVIDER_CONTRACT_CHANGED`,
`PROVIDER_OPERATION_AMBIGUOUS`, `PROVIDER_RESPONSE_TOO_LARGE`,
`PROVIDER_UNAVAILABLE`, `TRANSPORT_NOT_ALLOWED`, `CONSENT_REQUIRED`,
`LEASE_EXPIRED`, `CLAIM_EXPIRED`, `CLAIM_NOT_VERIFIED`, `CLAIM_ACTION_CONSUMED`,
`REAUTHORIZATION_REQUIRED`, `BOOTSTRAP_AUTHORITY_REMAINS`,
`SECRET_CUSTODY_UNAVAILABLE`, `RESOURCE_NOT_SUPPORTED`, `WORK_BUDGET_EXCEEDED`.

Transport requests are HTTPS-only and restricted to `api.cloudflare.com`, with a
bounded timeout (15 s default, 60 s ceiling) and a 256 KiB response ceiling.
Tests run fully offline against sanitized fixtures whose credentials are
prefixed `FAKE-`.

## Convex self-host on Cloudflare Containers (anon, opt-in)

`provisionConvexBackendOnCloudflare()` can anon-deploy the official
`ghcr.io/get-convex/convex-backend` image as a Workers Container behind a
proxy Worker. **No local Docker. No permanent `CLOUDFLARE_API_TOKEN`.**

Uses Temporary Accounts (PoW) → `wrangler deploy` with temp creds (not
`--temporary`, which races Containers apply). Image is a registry URI —
Cloudflare pulls it.

**Examples anon Temporary Convex self-host is fail-closed** under zero project
API keys (`@hobo/provider-convex` `provisionConvexBackendAnonymous` rejection
matrix). Cloudflare Temporary Containers apply returns **403**; opt in with
`HOBO_CONVEX_OCI_HOST=cloudflare`. Mock via `HOBO_CONVEX_SWAGHAUS_MOCK=1`.

**Local website (preferred):** `pnpm --filter hobo-site run dev` serves
same-origin `POST /HoBo/api/cf-temp/station` via Vite middleware → Temporary
Accounts REST. Examples Deploy stations works with **only the website** — no
external CORS relay URL, no permanent tokens.

**Static hosts (GitHub Pages):** set `PUBLIC_HOBO_STATION_BROKER_URL` to a live
Temporary Accounts CORS relay from:

```bash
pnpm exec tsx scripts/bootstrap-cf-cors-relay.mts
# → relayUrl + claimUrl  (open claimUrl to keep past ~60m)
```

Agents can also call `provisionTemporaryEnvironmentStation()` directly
(Node Temporary Accounts — proven live). Fail closed if broker unreachable —
never `blob:` as Cloudflare.

Note: Temporary Worker–hosted CORS relays may hit Cloudflare edge **1042** when
managing sibling Workers Scripts; prefer same-origin `/api/cf-temp` locally, or
claim the relay account / provision from Node Temporary Accounts.
Aligns with HoBo claim semantics (`deployment.Claimed` / anonymous → account).

## Boundary note: iac-pulumi is test-only

The workspace boundary guard forbids adapter → adapter runtime imports
(providers may import only core ports). `realize()` therefore emits a plain
typed `IacProgram` object (see `src/iac-program.ts`) mirroring the
`@hobo/iac-pulumi` published wire shape, with **no** runtime or `package.json`
dependency on that adapter. `@hobo/iac-pulumi` is imported **only** from
`test/conformance-iac-pulumi.test.ts` to prove — at test time — that the real
`validateIacProgram()` / backend conformance suite accepts the emitted programs.

## Architecture evidence

- `data-models/` — protobuf records + CUE constraints for the capability
  manifest and provider ports
- `contracts/provider-cloudflare-boundary.pact.json` — ProviderCloudflareBoundary
  pact (manifest publish + hello-bindle realize)
- `contracts/provider-cloudflare-realize-emission.pact.json` —
  RealizeEmissionBoundary pact (ResourcePlan → IacProgram)
- `ADR.md` — parse-don't-validate + realize-emission / event-architecture
  evidence

## Validation

```bash
pnpm --filter @hobo/provider-cloudflare run build
pnpm --filter @hobo/provider-cloudflare run test
```

Run both commands after changing temporary-account or realization boundaries.

## Direct provider APIs — the default deployment path

The default way to deploy to Cloudflare in this package is **direct HTTPS calls
to the Cloudflare API v4**. There is no IaC engine in the middle: no program to
emit, no separate state file, no second tool to keep in sync. The pieces are:

| Module | What it owns |
|---|---|
| `src/transport.ts` | `cloudflareTransportPolicy()` / `guardedCloudflareTransport(inner)` — the CF-scoped guard around an **injected** `HttpTransport` |
| `src/resolvers.ts` | `cloudflareResolvers(options)` / `cloudflareResolverRegistry(options)` — one `ResourceResolver` per product |
| `src/default-yard.ts` | `cloudflareYard(options?)` / `cloudflareYardSpec(options?)` / `CLOUDFLARE_DEFAULT_BINDINGS` — the allocatable catalog |

Nothing here reaches for a global `fetch`. A host supplies the transport, and
`guardedCloudflareTransport()` is what makes any supplied transport safe to hand
a credential: HTTPS only, exactly `api.cloudflare.com`, only the `/client/v4/`
path prefix, no redirect chasing, bounded body, bounded time. The enforcement
itself is `guardTransport()` in `@hobo/core`; this package owns only the numbers.

```ts
import {
  cloudflareResolverRegistry,
  guardedCloudflareTransport,
} from "@hobo/provider-cloudflare";

const transport = guardedCloudflareTransport(hostTransport);
const registry = cloudflareResolverRegistry({
  accountId,
  // A LOCATOR is passed in; the resolver never holds credential material.
  resolveCredential: (ref) => hostSecrets.read(ref),
});

const outcome = await registry.get("cloudflare.r2/v1")?.reconcile(
  {
    ref: { slot: "bucket", productId: "cloudflare.r2/v1", logicalId: "app-uploads" },
    desired: {},
    credentialRef: "env://CLOUDFLARE_API_TOKEN",
  },
  transport,
);
```

### Convergence is the point

Every `reconcile()` is **read-or-create**: it asks Cloudflare whether a resource
with the deterministic name already exists — by a direct `GET` where the API
offers one, by a fully paged list where it does not — *before* it creates
anything, then applies only the mutable deltas. Running it twice yields the same
`physicalId` and exactly one resource, which is what makes a crashed half-apply
safe to re-run. `delete()` treats a 404 as success for the same reason.

Actions are reported precisely: `create` when nothing was there, `update` when a
delta was applied, `noop` when the request already named the resource and
nothing changed, and `adopt` when the resolver found a resource the request did
not know about. **`replace` is never emitted** — replacing a bucket, a database,
or a KV namespace destroys data, so drift on an immutable field is reported as a
diagnostic and left for a human.

### Credentials are locators

`credentialRef` is a locator (`env://CLOUDFLARE_API_TOKEN`,
`secret://camp/cf-token`), and the resolver refuses anything that looks like the
material itself (`RESOLVER_CREDENTIAL_NOT_A_REF`) — a raw token in a request
record is a token in the event log. A blank or unresolvable ref is
`RESOLVER_CREDENTIAL_MISSING` with remediation, never a silent skip or an
unauthenticated retry. Cloudflare's error text is redacted of anything
token-shaped before it reaches a message or a diagnostic.

## The default exported Yard is a catalog, not a choice

`cloudflareYard()` returns **what Cloudflare CAN allocate** — not what an app
uses, not a mapping already made, not a pool. A capability slot may therefore
list **several** options, and selection (ADR-0151: hard gates, then
lexicographic ordering) picks among them later against the app's actual
capability requirement:

| Slot | Options |
|---|---|
| `bucket` | `cloudflare.r2/v1` |
| `data` | `cloudflare.d1/v1` |
| `kv` | `cloudflare.kv/v1` |
| `queue` | `cloudflare.queues/v1` |
| `service` | `cloudflare.workers/v1` |
| `web` | `cloudflare.pages/v1`, `cloudflare.workers/v1` |

The HTTP Worker entry explicitly sets `workersDev: true`. A generic `workers()`
binding leaves exposure unchanged, so allocating a queue consumer does not
silently publish it. The compute manifest names `cloudflare.workers/v1` directly
so selection reaches the executable Worker resolver.

Every row is built from the `src/slots.ts` factories, never hand-written, so the
catalog cannot drift from the product ids the resolvers key on.
`CLOUDFLARE_DEFAULT_BINDINGS` is the frozen, canonically sorted row set in the
`YardBindingInput` shape `@hobo/yards` consumes, and `cloudflareYardSpec()` adds
the provider and regions:

```ts
import { yard } from "@hobo/yards";
import { cloudflareYard, cloudflareYardSpec } from "@hobo/provider-cloudflare";

const catalog = cloudflareYard({ regions: ["weur"] });
const edge = yard(catalog.name, cloudflareYardSpec({ regions: ["weur"] }));
```

This package is a layer-2 adapter, so it does **not** import `@hobo/yards`; it
emits rows and lets layer 3 compose them.

## Parse, don't validate

`slotBinding()` (in `@hobo/core`) is the parse boundary for every catalog row —
the factories in `src/slots.ts` and the catalog in `src/default-yard.ts` build
nothing by hand, so credential screening, JSON-safety, canonical key ordering,
and deep freezing all apply. On the resolver side the parse boundaries are
`parseEnvelope()` over every Cloudflare response (a non-envelope body is
`RESOLVER_OUTPUT_UNPARSEABLE`, a `success: false` body is
`RESOLVER_PROVIDER_REJECTED`) and the credential parse in `resolveToken()`. Each
returns **derived types** — `SlotBinding`, `ResolveOutcome`,
`CloudflareYardCatalog` — never a partially-valid object, and every refusal
carries a `code` rather than a message to match on.

## Event architecture

This package owns no aggregate. A deploy **command** routed at a Yard row
produces a `ResolveOutcome` here; the calling **actor** turns that outcome into
the `binding.Resolved` / `binding.Projected` / `binding.Unavailable` **event**
family and appends it to the durable **event store**, where **projections**
build the **materialized views** (**read store**) that report what a Camp
currently has allocated, with **snapshots** backing current status. The
resolvers are the effectful edge of that flow, not its owner.

## HONEST SCOPE — direct API path

- **Native Worker acceptance is scoped.** On 2026-10-30 the actual generic
  registry and bounded HTTPS transport created one anonymous Worker, read its
  exact uploaded source from the native multipart response, observed its
  enabled Workers.dev binding and account subdomain, and received HTTP 200
  with the expected body. Generic delete followed by an independent native
  read confirmed absence. Other products remain covered by offline contracts;
  this Worker result does not establish their live behavior or final billing.
- **The guard cannot prove what the host's transport does.** It constrains the
  request this package composes and the response it accepts. Whether the
  injected transport actually honours `timeoutMs`, refuses to follow a 302
  itself, and terminates TLS against the real Cloudflare certificate is the
  host's obligation.
- **`productId`s are what the factories emit.** Catalog registration is checked
  at resolution time (`YARD_BINDING_PRODUCT_UNKNOWN`), not here; a row in
  `CLOUDFLARE_DEFAULT_BINDINGS` is not evidence that a matching Resource
  Definition exists today.
- **The Yard catalog covers six slots only.** Cloudflare can serve capabilities
  it does not offer (`topic`, `secretRef`, `webhook`, and a dedicated `api` row
  among them). Their absence means no slot factory emits them yet.

### Cloudflare APIs covered — and not

| Product | Covered | Not covered |
|---|---|---|
| `cloudflare.r2/v1` | `GET`/`POST`/`DELETE` `/accounts/{id}/r2/buckets[/{name}]`, `cf-r2-jurisdiction` header, `locationHint`, `storageClass` | public/managed domains (`publicBucket` is reported as a diagnostic, not applied), CORS rules, lifecycle rules, event notifications, sippy, the S3 data plane |
| `cloudflare.d1/v1` | `GET ?name=`, `POST`, `PATCH` (read replication), `DELETE` on `/accounts/{id}/d1/database` | query execution, imports/exports, time-travel restore, per-database Worker bindings |
| `cloudflare.kv/v1` | paged `GET`, `POST`, `DELETE` on `/accounts/{id}/storage/kv/namespaces` | key read/write/list (`ttlSeconds` is per write and is reported as a diagnostic), bulk operations, namespace rename |
| `cloudflare.queues/v1` | paged `GET`, `POST`, `PUT` (queue `settings`), `DELETE` on `/accounts/{id}/queues` | consumers (`maxBatchSize` / `maxRetries` are consumer-scoped and reported as diagnostics), producers, dead-letter wiring, message push/pull |
| `cloudflare.workers/v1` | Native settings and single-module source `GET`, `PUT` module upload (`multipart/form-data`), explicit Workers.dev `GET`/`POST`, observed account subdomain, `DELETE` | routes, custom domains, cron triggers, secret provisioning, tail/logs, versions and gradual deployments, Durable Object migrations, multi-module source proof |
| `cloudflare.pages/v1` | `GET`, `POST`, `PATCH` (production branch), `DELETE` on `/accounts/{id}/pages/projects[/{name}]` | deployments (upload, rollback, retry), custom domains, build config beyond the production branch, Pages Functions |

Workers compare the actual native source digest and requested settings before
uploading. An unchanged Worker is adopted or reported as a noop. Source proof
preserves UTF-8 bytes, including BOM and line endings; malformed multipart,
unexpected modules and artifacts exceeding the bounded readback contract fail
closed. A settings response without source cannot establish readiness. Missing
pinned Workers require a new approved allocation identity. Paged lookups refuse
when a listing has not terminated within 25 pages, because a truncated list
cannot rule out an existing resource.

### Anonymous acceptance and production observations

The temporary-account transport enforces a total request deadline and streaming
response-byte bound. Its FormData encoding preserves the native worker upload
contract. A workers.dev endpoint is returned only after positive activation and
the provider's observed subdomain; the SDK no longer fabricates a hostname when
activation or subdomain observation is missing. Resource resolvers wrap the
injected HTTP transport in the provider guard, rather than relying on callers to
guard it. Placeholder zero prices carry `pricingStatus: "unknown"` and cannot
serve as verified free hosting quotes.

`deleteWorkerScript({accountId, apiToken, scriptName})` issues the scoped native
DELETE and independently reads the script settings; authentication failures are
not absence. The generic resolver was separately exercised through its actual
registry: the Worker returned HTTP 200 and independent native GET confirmed 404
after deletion at **2026-10-30T01:04:30Z**. The repeatable manual lane is
[`hosting-anonymous-acceptance.mts`](../../../scripts/manual/hosting-anonymous-acceptance.mts),
which persists no-replay intent and private account custody before Worker
creation. The temporary account's eventual cleanup and final billing remain
unconfirmed; a local TTL does not prove either.
