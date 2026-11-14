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
  (`project()`, `gitFunction()`, `queue()`, `schedule()`, `cron()`, `sandboxHost()`, `blob()`), REST resource
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
| `prisma` | `prisma.postgres/v1` (associated marketplace resource) | `data.postgres/v1` | Prisma-owned resource in its own Yard, connected to the Vercel Yard by a Junction | Vercel coordinates one ceremony; the Prisma resource is its **own** `ClaimItem` | `binding.postgresql/v1`, rotated after claim |
| `vercel` | `vercel.drop-temporary-station/v1` | temporary Environment Station | `anonymous-claimable` | account required to retain — **not** direct anonymous deployment | n/a |
| `vercel` | `netlify`-style authenticated path | n/a | see `@hobo/provider-netlify` | n/a | n/a |

### Two ownership facts, one provider ceremony

Vercel presents claiming a project and its connected database as a single
accept. HoBo models them as **two provider-owned `ClaimItem`s**
(`SPONSORED_CLAIM_ITEM_IDS`: `project`, `associatedResource`) with a dependency
edge from project to resource. The database stays in the Prisma Yard; the
shared ceremony does not change provider boundaries. Since a partial transfer
is possible, the bundle uses `claimAtomicity: "best-effort-saga"`.

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
It is the shared redactor (`@hobo/provider-redaction`) plus Vercel's claim
and transfer codes, and the shared one's tests hold the hostile-text cases.
It searches the first `REDACTION_WINDOW` (8192) characters of a text, or four
times its `maxLength` when that is more, and, when that cut falls inside a run of
non-whitespace, the rest of that run, and marks a longer text cut; every shape is
linear in the text. So a hostile body of a megabyte with whitespace in it costs
no more than the window, a long body with none, such as compact JSON, is searched
whole and still shows its start, redacted, and no credential the cut runs
through leaves anything behind. A private key with a BEGIN line and no END line
is redacted to the end of what is searched, and a key is redacted from its BEGIN
line to its own END line, past any other END line (a certificate's) inside it.

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
| `src/slots.ts` | `staticDeployment`, `project`, `gitFunction`, `queue`, `schedule`, `cron`, `sandboxHost`, `blob`, `edgeConfig`, `vercelSlots` | Typed factories that emit `SlotBinding` records through core's parse boundary |
| `src/resolvers.ts` | `vercelResolvers`, `vercelResolverRegistry`, `VERCEL_RESOLVER_TRANSPORT_POLICY`, `VERCEL_UNRESOLVED_PRODUCT_IDS` | `ResourceResolver` implementations that converge a resource against the REST API |
| `src/default-yard.ts` | `vercelYardSpec`, `vercelSlotCatalog`, `vercelYardRows`, `VERCEL_DEFAULT_BINDINGS` | The default Yard catalog as raw, canonically-sorted rows |

### Slot factories

Each factory has its own options type — never `Record<string, unknown>` in the
signature — and returns `slotBinding({…})` from `@hobo/core`, so credential
screening, JSON-safety, key sorting, and freezing all happen at core's parse
boundary rather than here.

| Factory | Slot | Profile | Product id |
| --- | --- | --- | --- |
| `staticDeployment(options?)` | `web` | `web.hosted/v1` | `vercel.static-deploy/v1` |
| `project(options?)` | `web` | `web.project/v1` | `vercel.project/v1` |
| `edgeFunction(options?)` | `service` | `service.worker/v1` | `vercel.edge-function/v1` |
| `gitFunction(options?)` | `api` | `api.http/v1` | `vercel.function/v1` |
| `queue(options?)` | `queue` | `queue.at-least-once/v1` | `vercel.queues/v1` |
| `schedule(options?)` | `service` | `service.scheduled/v1` | `vercel.schedules/v1` |
| `cron(options?)` | `service` | `service.scheduled/v1` | `vercel.cron/v1` |
| `sandboxHost(options?)` | `service` | `service.batch/v1` | `vercel.sandbox-host/v1` |
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
| `vercel.blob/v1` | `GET /v1/storage/stores`, `POST /v1/storage/stores/blob`, `GET /v1/storage/stores/{id}`, project connection `POST`/`PATCH`/`DELETE`, `DELETE /v1/storage/stores/blob/{id}` |
| `vercel.project/v1` | `POST /v11/projects`, `GET /v9/projects/{idOrName}`, `POST /v9/projects/{idOrName}/link`, `PATCH /v9/projects/{idOrName}`, `DELETE /v9/projects/{idOrName}` |
| `vercel.function/v1` | Staged Git deployment with `POST /v13/deployments` and scoped deployment/project readback |
| `vercel.queues/v1`, `vercel.schedules/v1`, `vercel.cron/v1` | Verify components of the exact Git deployment; enable or disable preview schedules via the Vercel Schedules API |
| `vercel.sandbox-host/v1` | Read the project and Sandbox list; attach only after separate workload authorization, quota and pricing evidence |
| `vercel.edge-config/v1` | `POST /v1/global-config`, `GET /v1/global-config`, `GET /v1/global-config/{edgeConfigId}`, `PUT /v1/global-config/{edgeConfigId}`, `DELETE /v1/global-config/{edgeConfigId}` |

The planner advertises `vercel.queues/v1` for at-least-once and delayed queues.
Use the `queue` and `delayedQueue` slot factories to declare topics and their
consumer entries. Each queue depends on its Git function deployment: the
supervisor verifies that exact deployment's queue triggers before reporting the
component ready. There is no standalone queue provisioning path, and the
provider's price is unknown until the hosting budget authority supplies a
verified quote. Queue retirement also requires independently verified drain
and producer fencing.

The `schedule` slot factory declares a private Vercel Schedule with its
function entry and expected jitter. It is selected as `vercel.schedules/v1`
and verified against its owning Git deployment; preview activation and
production routing require the supervisor's separate provider readback.
`createVercelBlobDefinition` describes the native Blob product with unknown
conformance and unavailable custody by default; account evidence, quota,
credentials and a current quote must be verified separately.
`createVercelProjectDefinition` describes an operator-owned project and also
requires separately verified ownership, Git linkage, permissions and costs.

Sandbox host selection does not create a VM. The host must supply fresh proof
for the exact team, project, revision and representative guest/proxy workload:
runtime identity, Sandbox creation permission, capacity for both VMs, and a
complete cost quote. Broker admission and reservation are still required for
each job. Detachment requires an admission fence and drained sessions.

The Git function resolver can receive approved, nonsecret deployment variables
as `environmentVariables: [{ name, value }]`. `parseVercelGitEnvironment`
screens the supported public context and fleet values before the supervisor
records them. The hosting authority must independently verify the signed
Junction context or fleet, and the resolver includes the canonical values in
the operation identity. Raw credentials are not deployment variables.

Vercel renamed the Edge Config REST surface to `/v1/global-config` (the path
parameter is still `edgeConfigId`); the product id keeps the `edge-config` name
the catalog fixes, and the resolver calls the current documented path.

Blob discovery and project connection use the same storage API as Vercel's
CLI. The resolver requires an explicit team, project ID, region, access mode,
environments and operation ID, plus a durable mutation journal and shared
mutation scope. It connects through OIDC without creating a static read-write
token. A same-name store is adopted only when it is already connected to the
approved project; an ambiguous or unconnected store requires its exact ID.
Deletion requires that ID, preserves other projects and environments, and only
deletes a store when `deleteWhenEmpty` is explicitly set and its observed count
is zero. The caller must enforce its own retention and writer-quiescence policy.
An interrupted mutation retains the durable scope as uncertain. Recovery needs
independent verification of the provider state and the recorded physical ID;
the current scope has no automatic unlock for an uncertain mutation.

**Endpoints deliberately absent** (`VERCEL_UNRESOLVED_PRODUCT_IDS`):

| Product id | Why there is no resolver |
| --- | --- |
| `vercel.edge-function/v1` | A function is produced by a deployment. Vercel documents no endpoint that creates one as a standalone resource, so there is nothing to converge against. |

The product id stays in the Yard catalog — a Yard declares what can be
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
`VERCEL_RESOLVER_TRANSPORT_POLICY`: HTTPS only, `api.vercel.com` only, the
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
- **Standalone edge functions cannot be deployed by this package**
  (`vercel.edge-function/v1`), for the reasons tabled above. A
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
profile `web.project/v1`, so a project without a deployed artifact cannot
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

## Observe-only adoption of a Git-integration deployment

`src/git-integration-adoption.ts` is the Vercel side of adopting a deployment
Vercel's Git integration made, for a publisher that observes an existing
deployment without holding a Vercel token.
Pure functions over the JSON GitHub's Deployments API returns; the caller owns
the transport and the credential, and nothing here reads the network or the
environment:

| Export | What it decides |
|---|---|
| `vercelGitDeploymentRecords` | which records are Vercel's deployment of a commit for a project and target (`Production – hobo-ci`, exactly: `hobo-ci-relay` is not `hobo-ci`) |
| `vercelGitDeploymentStatus` | the state the latest status reports (`success` READY, `failure`/`error` ERROR, `inactive` SUPERSEDED, otherwise QUEUED/BUILDING) and the https URL and `vercel.com` inspector URL of the newest status naming them |
| `vercelAdoptionVerdict` | converged only when the deployment is READY and is the deployment of the pinned commit; ERROR, SUPERSEDED and COMMIT_MISMATCH are blocked (`VERCEL_GIT_BLOCKED_STATES`) |

It never creates, promotes, aliases or cancels a deployment, and adds no method
to the provider port. GitHub's records carry no Vercel `dpl_` id, so the id
adopted is GitHub's record id. Exercised against recorded-shape fixtures only
(`test/git-integration-adoption.test.ts`).

## Delivery coverage (ADR-0182: I14)

`VERCEL_HOSTING_COVERAGE` (contract `hobo.provider-hosting-coverage/v1`,
`data-models/hosting_coverage.{proto,cue}`) states, for every catalogued
product, a shipped resolver (`vercel.blob/v1`, `vercel.edge-config/v1`, `vercel.project/v1`,
`vercel.static-deploy/v1`) or a typed refusal with remediation
(`vercel.edge-function/v1`);
`vercelProductRefusal(productId)` returns the `RESOLVER_PRODUCT_UNSUPPORTED`
error. `VERCEL_TRAFFIC_ROUTING_PROFILE` is the audited profile, byte-equal to
`@hobo/connectivity`'s: `edge.canary` (Rolling Releases), `edge.path`,
`edge.header`, with `inprocess.weighted` as the Station-side fallback; the
other fourteen portable offerings are declared absent with a reason
(`VERCEL_TRAFFIC_ROUTING_ABSENT`). `vercelResolverRegistry` takes optional
`metrics` + `nowMs` and then emits `hobo.cd.resolver.operations` and
`hobo.cd.resolver.duration` for every call.

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `RESOLVER_PRODUCT_UNSUPPORTED` for `vercel.blob/v1` | required team, project, environment, or durable coordination is missing | supply the approved binding and durable journal and mutation scope |
| `RESOLVER_PRODUCT_UNSUPPORTED` for `vercel.edge-function/v1` | functions ship inside a deployment | deliver them with the project deployment |
| a canary is lowered to `inprocess.weighted` | Rolling Releases were not realizable for the plan | check the two mapped deployment ids; the rung is recorded (`rollout.Lowered`) |
| no `hobo.cd.resolver.*` metrics | the registry was built without `metrics` and `nowMs` | pass both; a sink without a clock is refused |
