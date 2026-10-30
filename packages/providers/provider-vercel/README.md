# @hobo/provider-vercel

Vercel CloudProvider for HoBo Examples OOB yards.

- Equivalence → default Resource Definitions (`EQUIVALENCE_CLASSES` / `createVercelProvider`)
- Matching `satisfies` full|partial|none + typed impedance (`vercelImpedanceFindings`)
- **Temporary / agent stations via [Vercel Drop](https://vercel.com/docs/drop)** —
  `provisionTemporaryEnvironmentStation()` creates a **new** project from uploaded
  files (Drop semantics). Injectable transport for tests; default CLI
  Drop-equivalent uses a local `vercel login` session and **strips**
  `VERCEL_TOKEN` (never permanent API tokens on this path). Browser Drop:
  https://vercel.com/drop
- **Sponsor-backed claim strategy `vercel.sponsored-project-transfer/v1`** — HoBo
  owns and pays for the project until a human accepts a project transfer request.
  See below.
- **Direct-HTTPS deployment path (the default)** — typed slot factories
  (`project()`, `edgeFunction()`, `blob()`, `edgeConfig()`), REST resource
  resolvers (`vercelResolvers` / `vercelResolverRegistry`), and the default Yard
  catalog (`vercelYardSpec`). No IaC engine, no CLI. See
  [Direct-HTTPS deployment path](#direct-https-deployment-path).

```sh
pnpm --filter @hobo/provider-vercel test
```

## `vercel.sponsored-project-transfer/v1`

### This is not an anonymous deployment

The distinction is the whole point of the definition, so it is stated in data
(`SPONSORED_PROJECT_TRANSFER_BOOTSTRAP`) and asserted by test:

| Fact | Value |
| --- | --- |
| `bootstrapClass` | `sponsor` |
| `publiclyAnonymous` | `false` — there is an account and a payer before the claim |
| `initialOwner` | `hobo-sponsor` |
| `costBearerBeforeClaim` | `hobo-sponsor` (`costBearerAfterClaim`: `claiming-team`) |
| `sponsorExposureMinorUnits` | `500` — HoBo's own exposure cap, ranking input only |
| Isolation | dedicated sponsor team + project; credential scoped to `single-project-deploy-and-transfer`; never shared across tenants |

`SPONSOR_BUDGET_EXCEEDED` is a refusal, not a warning: `assertSponsorBudget`
rejects a candidate whose exposure exceeds the caller's cap before anything is
created.

Vercel **Drop** is kept separate (`VERCEL_DROP_CLASSIFICATION`,
`drop-classification.ts`). Drop is `anonymous-claimable`, but retaining a Drop
project requires an account, so it is explicitly **not** classified as a direct
anonymous deployment.

### Provider / product / capability / bootstrap / claim / binding

| Provider | Product | Capability profiles | Bootstrap | Claim | Binding |
| --- | --- | --- | --- | --- | --- |
| `vercel` | `vercel.sponsored-project-transfer/v1` (application) | `web.static/v1`, `web.hosted/v1`, `api.http/v1` | sponsor-backed; HoBo-owned project in an isolated sponsor team | project transfer request; **1** human action; code valid **24 h**; atomicity `provider-bundled` | `binding.http/v1` |
| `vercel` + `prisma` | `prisma.postgres/v1` (associated marketplace resource) | `data.postgres/v1` | created inside the sponsored project boundary | transferred in the *same* Vercel ceremony, tracked as its **own** `ClaimItem` | `binding.postgresql/v1`, rotated after claim |
| `vercel` | `vercel.drop-temporary-station/v1` | temporary Environment Station | `anonymous-claimable` | account required to retain — **not** direct anonymous deployment | n/a |
| `vercel` | `netlify`-style authenticated path | n/a | see `@hobo/provider-netlify` | n/a | n/a |

### Two ownership facts, one provider ceremony

Vercel presents claiming a project and its connected database as a single
accept. HoBo models them as **two `ClaimItem`s** (`SPONSORED_CLAIM_ITEM_IDS`:
`project`, `associated-resource`) under `claimAtomicity: "provider-bundled"`,
with a dependency edge from project to resource.

This is what makes the failure mode representable: when the project transfers
and the Prisma resource does not, the shared `@hobo/claims` reducer refuses
`CompleteClaimBundle`, the bundle lands in repair with the resource item
outstanding, and `runSponsoredProjectTransferClaim` reports
`atomicSuccess: false`. There is no code path that reports atomic success on a
partial transfer.

`RESOURCE_TRANSFER_CAPABLE_MARKETPLACE_PROVIDERS` records all three providers
the docs name (`neon`, `prisma`, `supabase`); only `prisma` is wired end to end
(`MODELLED_ASSOCIATED_RESOURCE`), because a transfer path is not real until its
verification and rotation steps exist.

### After the claim

Both ownership facts are verified **independently** — a provider "yes" is not
verification:

- **Project** — `verifyProjectOwnership` requires the `accountId` on
  `GET /v9/projects/{idOrName}` to have moved *and* the sponsoring credential to
  have lost access. `verifyTransferAcceptanceCallback` checks the HMAC-SHA256
  webhook signature when a callback is configured.
- **Associated resource** — `verifyAssociatedResourceOwnership` goes through an
  injected `AssociatedResourceOwnershipProbe`. Vercel exposes no
  claims-generator-side endpoint for this, so the port is the honest shape;
  the unverified case is `CLAIM_NOT_VERIFIED`, never an assumption.
- **Sponsor authority removed** — `revokeSponsorAuthority` deletes every token
  id known *before* the claim via `DELETE /v3/user/tokens/{tokenId}`;
  already-gone tokens are success, not error.
- **Bindings rotated** — `rotateAssociatedResourceBinding` emits a new
  `SecretRef` and refuses plaintext credential material
  (`BINDING_ROTATION_REQUIRED` when rotation has not happened).

The claim URL is a bearer token. `buildClaimAction` returns it as a
`SecretValue` and `storeClaimAction` deposits it in the `@hobo/claims` one-time
action store; callers get a redacted handle.

### Verified provider facts

All URLs below were fetched and read on the dates shown
(`VERCEL_EVIDENCE_CHECKED_AT`, `SPONSORED_PROJECT_TRANSFER_SOURCES`). These are
ranking input, never billing input, and no vendor signed anything.

| Fact | Source | Checked |
| --- | --- | --- |
| Claim URL is `https://vercel.com/claim-deployment` with the transfer code in a `code` query parameter; associated resources transfer with the project; accept is `PUT /projects/transfer-request/:code` | https://vercel.com/docs/deployments/claim-deployments | 2026-08-08 |
| `POST /projects/{idOrName}/transfer-request` returns a code **valid 24 hours**; optional `callbackUrl` + `callbackSecret` webhook signed HMAC-SHA256; `410` on an expired code | https://vercel.com/docs/rest-api/reference/endpoints/projects/create-project-transfer-request | 2026-08-08 |
| Resource transfer accept calls the integration server twice (verify, then accept); documented failure modes include invalid provider claim id, missing installation, billing plan conflict, resource ownership | https://vercel.com/docs/integrations/create-integration/marketplace-flows | 2026-08-08 |
| `GET /v9/projects/{idOrName}` returns a required `accountId` — the post-transfer ownership fact | https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name | 2026-08-08 |
| `DELETE /v3/user/tokens/{tokenId}` invalidates a token; `current` invalidates the authenticating token | https://vercel.com/docs/rest-api/reference/endpoints/authentication/delete-an-authentication-token | 2026-08-08 |
| Function request/response body cap 4.5 MB; Hobby max duration 300 s; streaming supported | https://vercel.com/docs/functions/limitations | 2026-08-08 |

**Unverified / deliberately absent.** Numeric capability keys appear on the
candidate only where a doc states them, so a `required` ask for an unread limit
fails closed instead of selecting on a guess. Not verified here: any per-file or
file-count deploy limit; websocket upgrade (declared unsupported); Neon and
Supabase transfer paths (recorded, not wired); whether the claims generator can
read associated-resource ownership after transfer (hence the injected probe).

### Errors, transport, idempotency

Typed `VercelProviderError` with stable codes: `PROVIDER_RATE_LIMITED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_CONTRACT_CHANGED`,
`PROVIDER_OPERATION_AMBIGUOUS`, `CLAIM_EXPIRED`, `CLAIM_NOT_VERIFIED`,
`CLAIM_PARTIALLY_COMPLETED`, `BINDING_ROTATION_REQUIRED`,
`SPONSOR_BUDGET_EXCEEDED`, `SECRET_CUSTODY_UNAVAILABLE`. `redactProviderText`
strips credential shapes from anything that reaches a log or an error detail.

`createGuardedTransport` allows HTTPS only, to `api.vercel.com` only
(`VERCEL_API_ALLOWED_HOSTS`), on allowlisted path prefixes, with no redirects
and bounded response size and timeout.

An ambiguous timeout is resolved by observation, not retry:
`observeOrAdoptProject` adopts the existing project when it is already there and
reports the already-transferred and unreachable cases distinctly, so a repeated
bootstrap cannot double-create.

Tests are offline. Fixtures under `test/fixtures/` carry obviously fake
credentials (`FAKE-…`).

## Direct-HTTPS deployment path

HoBo's default way to put a resource on Vercel is to call Vercel's documented
REST API over an injected, guarded transport. There is no infrastructure-as-code
engine holding a state file, no plan/apply round trip, and no shelling out to
`vercel`. Three modules make that path:

| Module | Exports | What it is |
| --- | --- | --- |
| `src/slots.ts` | `project`, `edgeFunction`, `blob`, `edgeConfig`, `vercelSlots` | Typed factories that emit `SlotBinding` records through core's parse boundary |
| `src/resolvers.ts` | `vercelResolvers`, `vercelResolverRegistry`, `VERCEL_RESOLVER_TRANSPORT_POLICY`, `VERCEL_UNRESOLVED_PRODUCT_IDS` | `ResourceResolver` implementations that converge a resource against the REST API |
| `src/default-yard.ts` | `vercelYardSpec`, `vercelSlotCatalog`, `vercelYardRows`, `VERCEL_DEFAULT_BINDINGS` | The default Yard catalog as raw, canonically-sorted rows |

### Slot factories

Each factory has its own options type — never `Record<string, unknown>` in the
signature — and returns `slotBinding({…})` from `@hobo/core`, so credential
screening, JSON-safety, key sorting, and freezing all happen at core's parse
boundary rather than here.

| Factory | Slot | Profile | Product id |
| --- | --- | --- | --- |
| `project(options?)` | `web` | `web.hosted/v1` | `vercel.project/v1` |
| `edgeFunction(options?)` | `service` | `service.worker/v1` | `vercel.edge-function/v1` |
| `blob(options?)` | `bucket` | `bucket.object/v1` | `vercel.blob/v1` |
| `edgeConfig(options?)` | `kv` | `kv.key-value/v1` | `vercel.edge-config/v1` |

The whole option bag is forwarded minus `undefined` values, so an undeclared key
is **screened** by core rather than silently dropped — a swallowed `apiKey` is
worse than a refusal. No defaults are invented for provider settings: absent
means absent, and the Resource Definition decides what an unset `framework` or
`access` means.

### The default Yard

A Yard declares what **can** be allocated on a provider. It is not a mapping,
not a pool, and not a record of what an app uses, which is why the catalog holds
an array per slot: a slot may list several offerings and selection (ADR-0151)
picks among them later. `vercelYardSpec()` returns
`{ provider: "vercel", regions, bindings }` where `bindings` is the flat row
array sorted by `(profile, productId, connectivityId)` — the same canonical
order `@hobo/yards` imposes, so the hand-off is byte-stable. This is a layer-2
adapter: it emits raw rows and never imports `@hobo/yards`.

`regions` defaults to Vercel's documented default function region (`iad1`). An
empty or malformed region list is refused (`VERCEL_YARD_REGIONS_EMPTY`,
`VERCEL_YARD_REGION_INVALID`) rather than silently replaced with the default.

### Resolvers

`reconcile` is convergent and idempotent: it looks the resource up first — by
`ref.physicalId` when the caller has one, otherwise by the deterministic name
derived from the request — and only then creates. Running it twice yields one
resource and the same `physicalId`; the second run reports `adopt` (the resource
exists and the request did not name it) or `noop` (the request named it and
nothing differs). `delete` treats a 404 as success. `read` powers adoption and
state recovery. `replace` is never emitted: nothing here deletes and re-creates
a resource behind the caller's back.

**Endpoints covered.**

| Product id | Endpoints |
| --- | --- |
| `vercel.project/v1` | `POST /v9/projects`, `GET /v9/projects/{idOrName}`, `PATCH /v9/projects/{idOrName}`, `DELETE /v9/projects/{idOrName}` |
| `vercel.edge-config/v1` | `POST /v1/global-config`, `GET /v1/global-config`, `GET /v1/global-config/{edgeConfigId}`, `PUT /v1/global-config/{edgeConfigId}`, `DELETE /v1/global-config/{edgeConfigId}` |

Vercel renamed the Edge Config REST surface to `/v1/global-config` (the path
parameter is still `edgeConfigId`); the product id keeps the `edge-config` name
the catalog fixes, and the resolver calls the current documented path.

**Endpoints deliberately absent** (`VERCEL_UNRESOLVED_PRODUCT_IDS`):

| Product id | Why there is no resolver |
| --- | --- |
| `vercel.edge-function/v1` | A function is produced by a deployment. Vercel documents no endpoint that creates one as a standalone resource, so there is nothing to converge against. |
| `vercel.blob/v1` | `POST /storage/stores/blob`, `GET /storage/stores/{id}` and `DELETE /storage/stores/blob/{id}` are documented, but **no documented endpoint lists stores by name**. Without name lookup, `reconcile` could not discover an existing store and would create a second one on every retry. A silently non-convergent resolver is worse than an absent one. |

Both product ids stay in the Yard catalog — a Yard declares what can be
allocated, and expressing an offering is not the same claim as deploying it. The
test suite asserts that the set of catalogued rows without a resolver is
*exactly* `VERCEL_UNRESOLVED_PRODUCT_IDS`, so adding a row without a resolver
fails unless the gap is declared.

### Credentials, transport, errors

`credentialRef` is a **locator**, never material. It is parsed with
`parseSecretRef`, so a raw token, a connection string, or an unregistered scheme
is refused with `RESOLVER_CREDENTIAL_NOT_A_REF` and never echoed into the error
message. The value comes from the injected
`resolveCredential(ref) => Promise<string>`; a locator custody cannot answer for
raises `RESOLVER_CREDENTIAL_MISSING` with remediation. The resolved value lives
in a `SecretValue` and is exposed only by the `authorization` header builder.

Every call goes through core's `guardTransport` with
`VERCEL_RESOLVER_TRANSPORT_POLICY`: HTTPS only, `api.vercel.com` only, the two
allowlisted path prefixes above, no redirect chasing, bounded body and timeout.
The guard generalizes this package's own `createGuardedTransport` and
additionally speaks the PATCH that a project update requires. Nothing in this
package reaches for a global `fetch`.

A Vercel error body (`{ error: { code, message } }`) becomes
`RESOLVER_PROVIDER_REJECTED` with the provider's message passed through
`redactProviderText`, so a token echoed back in an error cannot reach a log. A
response that is not JSON, or is missing a documented field, becomes
`RESOLVER_OUTPUT_UNPARSEABLE`. A `desired` setting of the wrong type is refused
with `RESOLVER_PRODUCT_UNSUPPORTED` rather than dropped — a silently ignored
setting is a deployment that does not match what was asked for.

## HONEST SCOPE

- **Nothing here proves a live deploy.** The resolvers are exercised only
  against an injected fake transport in `test/resolvers.test.ts`. No test in this
  repo has contacted `api.vercel.com`. A live deploy additionally needs real
  credentials, network egress, and a Vercel account, and none of that is
  demonstrated by a green suite. Treat the endpoint tables above as "written
  against the documented contract", not as "verified against the running API".
- **Product ids are what the factories emit.** Whether a product id is
  registered in a catalog and matches the Yard's provider is checked at
  resolution time, in the selection path — not here, and not by a naming
  convention (ADR-0144 forbids inferring a provider from an id prefix).
- **Two of the four catalogued offerings cannot be deployed by this package**
  (`vercel.blob/v1`, `vercel.edge-function/v1`), for the reasons tabled above. A
  deploy that selects them fails closed at resolution with no registered
  resolver, rather than appearing to work.
- **No `replace` path.** A change to a field this package treats as stable is
  not handled by delete-and-recreate; only in-place `PATCH`/`PUT` deltas are
  applied.
- The Drop and sponsored-transfer paths above are unchanged and independent of
  this deployment path.

## Contracts and data models

- `data-models/provider_vercel.proto` — the records this package exchanges at
  the Vercel boundary and hands to `@hobo/claims`: the bootstrap disclosure, the
  transfer-code locator, the project read, the per-item claim record, the claim
  report, sponsor-authority revocation, the rotated database binding, and the
  Drop classification that keeps Drop apart from the sponsored strategy.
- `data-models/provider_vercel.cue` — the invariants over those records: a
  sponsored offer may never declare itself anonymous or carry zero exposure, the
  transfer deadline must equal the issue instant plus the documented 24 hour
  window, a stored locator must be a `hobo-secret://` / `hobo-token://` URI with
  no query string (that is where a code would ride), only the database item may
  owe a binding rotation, and `atomicSuccess` cannot coexist with an outstanding
  item.
- `contracts/provider-vercel-project-transfer-api.pact.json` — the consumer
  contract for the documented REST calls: create the transfer request, read
  `accountId` before and after the transfer, the forbidden read that means
  *unreachable by the sponsor*, the missing-`accountId` drift that fails closed,
  and token revocation including the already-gone case.
  `test/boundary.contract.test.ts` replays it through the real functions, so an
  interaction nobody exercises is a test failure rather than documentation.

Neither the proto nor the CUE is compiled at runtime: this package declares no
`data-models/buf.yaml` and imports no generated `*_pb.ts`. Where a TypeScript
declaration shares a name with a message, the declaration carries a
`parallel-type-allowed:` note saying why.

## Architecture evidence

**Parse, don't validate.** Untrusted provider bytes cross exactly one boundary
and come out as parsed derived types, or they do not come out at all:
`createProjectTransferRequest` seals the transfer code into a `SecretValue`
behind a custody locator instead of returning a string, `getProject` refuses a
body without the documented `accountId`, `verifyTransferAcceptanceCallback`
checks the HMAC before it reads a field, `buildClaimAction` rejects a non-HTTPS
`returnUrl`, and `rotateAssociatedResourceBinding` builds its binding through
`parseCapabilityBinding` + `parseSecretRef`. Downstream functions take those
derived domain types, so there is no second place where a raw payload is
re-checked. The direct-HTTPS path adds three more boundaries and no exceptions:
the slot factories return `slotBinding(…)`, every resolver entry point re-parses
its input with `parseResolveRequest`, and a REST body becomes a derived
`ProjectView` / `EdgeConfigView` or a typed `RESOLVER_OUTPUT_UNPARSEABLE`
refusal — never a half-parsed record.

## Event architecture

This package owns strategy and data; it owns no lifecycle. The facts it produces
flow through the shared claim plane in `@hobo/claims`:

- **Commands.** `sponsoredProjectTransferBootstrapCommands` and
  `sponsoredProjectTransferClaimCommands` compile observations into claim
  **commands** — `ReserveGuestLease`, `RecordProvisionedSubject`,
  `BeginClaimItem`, `ObserveClaimItem`, `VerifyOwnership`,
  `RotateCapabilityBinding`, `RevokeBootstrapAuthority`, `CompleteClaimItem`,
  `CompleteClaimBundle`. Two `RecordProvisionedSubject` commands, because the
  project and the Prisma database are separate ownership facts from the moment
  they exist.
- **Actor.** `runSponsoredProjectTransferClaim` folds those commands through
  `reduce`, the pure core of the claim coordinator **actor**. The completion
  attempt is unconditional on purpose: whether a bundle may be called complete is
  the reducer's ruling, not this driver's.
- **Events.** The reducer returns the **events** the host appends —
  `GuestLeaseReserved`, `ProviderSubjectProvisioned`, `ClaimStatusObserved`,
  `OwnershipVerified`, `CapabilityBindingRotated`, `BootstrapAuthorityRevoked`,
  `ClaimItemCompleted`, `ClaimBundleCompleted`, or `ClaimRepairRequested` when
  the project moved and the database did not. `assertNoSecrets` refuses to append
  a payload carrying a claim URL or a code, which is why this package deposits
  the claim action into the one-time action store before anything is emitted.
- **Event store.** Those events land in HoBo's durable **event store** (SQLite
  behind the `@hobo/core` ports by default, ADR-0135). Provider effects — the
  transfer request, the project read, the token deletions — happen outside that
  transaction, keyed by an idempotency key and recovered by
  `observeOrAdoptProject`, so an ambiguous timeout adopts rather than
  double-creates.
- **Projection and materialized view.** Folding the claim stream produces the
  claim-bundle **projection**: the **materialized view** that answers what is
  claimed, what is outstanding, and when the 24 hour code expires.
  `SponsoredClaimReport` is this package's honest slice of that view.
- **Snapshot and read store.** Periodic **snapshots** of that fold back the
  **read store** `hobo claim` queries for current status, so an operator asking
  whether the deployment changed hands reads a projection, never a live Vercel
  call — and never the claim URL, which lives only in custody.

### Production deployment and temporary API boundary

`vercelResolvers(options)` also registers `vercel.static-deploy/v1`. This product
uploads an immutable UTF-8 static artifact into an explicitly identified,
already-owned project using `POST /v13/deployments`. It leaves `target` unset so
creation produces a preview; Station controls traffic independently. Desired
properties are `projectId`, `name`, `operationId`, and a map of absolute file paths
to UTF-8 contents in `files`. Executable build configuration is refused.

All create POSTs require a host-owned `ResourceMutationJournal` with
`persistence: "durable-cas"`. An uncertain POST is discovered by the immutable
operation marker through bounded `GET /v7/deployments` pagination; it is never
blindly replayed. A pinned missing resource is not recreated. Independent
`GET /v13/deployments/{id}` must match project and team, reach a terminal native
state, and, for ready observations, fetch the actual bytes from its immutable
HTTPS deployment origin. Only those observed bytes produce `artifactDigest`.
A deployment acknowledgement, graph marker, or HTTP 200 alone is not application
health or final billing evidence. `DELETE /v13/deployments/{id}` uses native scope
and can retire an unhealthy artifact without relying on its public HTTP endpoint.

`VercelResolverOptions` accepts `mutationJournal`, optional credential-free
`artifactTransport`, and aggregate `maxArtifactBytes` / `maxArtifactFiles` limits.
The authenticated project and Edge Config resolvers require the same durable
journal for creation, reject foreign native identities and unknown settings,
and independently check ownership before deletion. Project and Edge Config
outputs do not assert a running application.

The SDK now reports `supportsAnonymousTemporaryDeploy: false`. Browser Drop is
not a documented anonymous SDK API. The former CLI fallback used an ambient
login, deployed with `--prod`, invented a dashboard claim link and local expiry,
and mislabeled the result anonymous. It has been removed. Calling
`createVercelDropCliTransport()` has no subprocess or account side effect and
refuses deployment. An explicitly injected temporary transport must provide a
native deployment ID, an observed claim-deployment action, explicit anonymous
authority and a provider-reported bounded expiry. Local materialization rejects
traversal, configuration files, duplicate paths and oversized artifacts and uses
a new isolated directory. The authenticated resolver remains available for
account-backed deployment; anonymous acceptance does not exercise that path.

The compute manifest publishes `vercel.static-deploy/v1` explicitly.
`createVercelStaticDeployDefinition()` and `VERCEL_DEFINITIONS` expose the
matching static/hosted semantics and executor. `staticDeployment({projectId})`
is the default Yard web offering. `project()` now uses the control-resource
profile `provider.project/v1`, so a project without a deployed artifact cannot
satisfy hosted application readiness. An explicitly configured project remains
available as a control resource. The compute capability no longer claims SSR
from a static-only deployment driver.

`data-models/anonymous_deployment.proto` owns injected temporary deployment
evidence, and the runtime contract derives its generated type. Its CUE schema
and executed positive/negative fixtures refuse invented anonymity, dashboard
links masquerading as ownership claims, and unreported expiry. The package now
opts into scoped Protobuf generation with `data-models/buf.yaml`. Native account
creation and deployment remain account-required and are not labeled live-tested
by anonymous acceptance.

A scoped ready deployment read also publishes `servingEndpoint` from the
validated immutable deployment origin after fetching its artifact. Pending and
failed deployments, project records, and guessed aliases provide no serving
endpoint proof. Endpoint metadata never substitutes for artifact or business
health evidence.
