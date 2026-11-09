# @hobo/provider-neon

Neon **Claimable Postgres** (Neon Launchpad) as a HoBo product definition plus
its effectful driver. One product, one capability: a real PostgreSQL database
you can provision with no account, and later transfer to a Neon account.

## Product

| Facet | Value |
|---|---|
| Provider | `neon` |
| Product / definition id | `neon.claimable-postgres/v1` |
| Capability profile | `data.postgres/v1` (**native**) — therefore `data.relational/v1` by refinement |
| Runtime models | `wasm`, `oci`, `vm_iaas`, `paas`, `serverless_faas` |
| Bootstrap | public anonymous, claimable — unauthenticated `POST`, no account, no card |
| Claim boundary | **resource** (one database / Neon project), never the account |
| Claim atomicity | `single-resource` |
| Binding profiles produced | `binding.postgresql/v1`, `binding.neon-serverless/v1` |
| Migration profiles | `migration.postgres.pg-dump/v1`, `migration.postgres.logical-copy/v1` |
| Expiry | **provider-reported** `expires_at`; this package never computes a local 72-hour timer |
| Sponsor exposure | 0 — the resource lives on Neon's own free allowance |

A relational-only product (Cloudflare D1) satisfies `data.relational/v1` and
**never** `data.postgres/v1`; `test/selection.test.ts` pins that asymmetry with
the real `selectCapabilityImplementation`.

## Verified against official documentation

Everything below was read on the date shown. Nothing in this package was
inferred from a blog aggregator or a model's memory.

| Source | Checked | What it confirmed |
|---|---|---|
| <https://neon.com/docs/reference/claimable-postgres> | 2026-08-08 | `POST https://neon.new/api/v1/database` with `{ref, enable_logical_replication?}` and **no authentication**; `GET /api/v1/database/:id`; response fields `id` (UUID v7), `status` ∈ `UNCLAIMED\|CLAIMING\|CLAIMED`, `neon_project_id`, `connection_string` (**null after claim**), `claim_url`, `expires_at`, `created_at`, `updated_at`; documented errors 400 `Missing referrer`, 400 `Database not found`, 500 `Failed to create the database.`; unclaimed limits 100 MB storage / 1 GB transfer / no branches / 72 h; databases run **Postgres 17 on AWS us-east-2**; the direct endpoint is the pooled hostname with `-pooler` removed |
| <https://neon.com/blog/neon-launchpad> | 2026-08-08 | Claiming is instant and zero-downtime, **"your connection strings will continue to work"**, and password rotation is an explicitly post-claim owner action |
| <https://neon.new/> | 2026-08-08 | The same unauthenticated create call and response fields on the product page |

The documented path this package uses — `POST https://neon.new/api/v1/database`
— is therefore **verified, not assumed**.

### Not verified, and treated as unknown

Unknown is modelled as *absent*, because an absent structured capability fails
a `required` feature gate while an optimistic one passes it.

- **`extensions`** and **`maxConnections`** are not documented for the unclaimed
  tier, so neither appears in `structuredCapabilities`. `pgvector` in particular
  is **not** claimed.
- **`preparedStatements: true`** is asserted for the *direct* endpoint (plain
  PostgreSQL 17). Behaviour through the `-pooler` endpoint under transaction
  pooling is not documented and is not separately claimed.
- **Conformance is fixture-based.** `NEON_CONFORMANCE_REF` points at an offline
  suite driven by the sanitized fixtures in `test/fixtures/`. No live
  provisioning has been executed from this repository.
- **The default candidate ships `evidenceSignatureValid: true`.** The catalog
  owner is expected to re-sign; pass `createNeonClaimablePostgresCandidate({
  evidenceSignatureValid: false })` until then.

## Why a claim is not "done" when Neon says `CLAIMED`

Neon documents that connection strings keep working across a claim. So at the
moment `status` flips to `CLAIMED`, the party that *created* the database still
holds a live credential. Reporting that as a completed claim would be a lie of
exactly the sort that ends up in a compliance answer.

The claim plan therefore carries two **blocking** actions:

1. `neon.claim.transfer-to-account` — the browser ceremony at `claim_url`.
2. `neon.claim.rotate-owner-credentials` — the owner rotates the role password.

`verifyClaim()` returns `complete: false` while either is outstanding, and the
state `claimed-pending-rotation` exists specifically to name that gap.
`attestRotation()` is the only way to reach `complete`, and it refuses to run
before the provider reports `CLAIMED`.

Selection metadata matches: `creatorAuthorityAfterClaim: "rotatable"`,
`continuity.credentials: "retained"`, `claimActionCount: 2`.

## Safety properties

- **No global `fetch`.** Every HTTP call goes through the injected
  `NeonTransport`. `createFetchTransport({ fetchImpl })` takes fetch as a
  required argument; `createGuardedTransport` enforces HTTPS, the `neon.new`
  host allowlist, the `/api/v1/` path prefix, no userinfo, no non-443 port, a
  bounded body (64 KiB default), a bounded timeout (15 s default), and **refuses
  to follow redirects** rather than chasing a `Location` to another origin.
- **Public serialization requires private custody.** A returned
  `connection_string` is deposited through `SecretCustodyPort`. Native SDK
  records remain privileged: the anonymous database ID, claim URL, and endpoint
  metadata can grant access or identify a capability. The async
  `toProvisionReceipt` and `toProviderFacts` require custody, a private host HMAC
  key deriver, and a tenant/account/deployment scope. Their v2 projections carry
  opaque identities and custody locators; they refuse missing custody, invalid
  locators, native capability material, and credential-shaped output. Keep the
  native client idempotency journal inside the private custody boundary.
- **Idempotency and adoption.** A create is attempted at most once per
  idempotency key. A repeat call with a recorded database id **observes**; a
  repeat call after an unresolved attempt raises `PROVIDER_OPERATION_AMBIGUOUS`
  and issues no `POST`. There is no account to find an orphaned anonymous
  database in, so duplicating one is worse than failing.
- **Ownership is not self-asserted.** `verifyOwnership()` returns
  `verified: false` when the only evidence is the provider's own control plane.
  Supply an `OwnershipProbePort` for an independent data-plane check.
- **Migrations never touch a shell.** `pg_dump`/`pg_restore`/`psql` are argv
  arrays handed to an injected `ProcessRunner`; credentials travel in libpq
  environment variables and SQL travels on stdin. A database named
  `neondb"; rm -rf / #$(id)` lands as exactly one `--dbname=…` element, which
  `test/migration.test.ts` asserts.
- **`migration.postgres.logical-copy/v1` fails closed** unless the database was
  created with `enable_logical_replication: true` — Neon cannot enable it after
  the fact. The DSN-bearing `CREATE SUBSCRIPTION` statement is deliberately not
  assembled by `buildLogicalCopyPlan`; the caller composes it inside the
  resolved-secret scope.

## Parse, don't validate

Nothing in this package re-checks a value it already accepted. Untrusted input
crosses one parser and comes out as a **derived domain type** that cannot hold
the bad case:

- `parseNeonDatabaseResponse` turns the raw JSON body into `NeonDatabaseResponse`
  — a UUID-shaped id, one of the three documented statuses, and a
  provider-reported `expires_at` instant. A body that is merely *close* is a
  `PROVIDER_CONTRACT_CHANGED`, not a partially-trusted object.
- `parsePostgresConnectionUri` is the only thing that ever looks at a connection
  string. It yields a host, port, database name, and a plaintext secret that is
  handed to custody inside the same function scope; downstream code receives a
  `SecretRef` and has no way to ask for the material.
- `endpointsFor` / `toDirectHost` produce `NeonEndpoints`, whose hosts are bare
  hostnames by construction, so no later code path has to remember to strip a
  scheme or userinfo.
- Claim state is a union (`unclaimed | claiming | claimed-pending-rotation |
  complete | expired`), not a boolean plus a comment, so
  "provider said CLAIMED but nobody rotated" is representable and
  `complete` is not.

`data-models/provider_neon.proto` is the wire view of these shapes, and it is
compiled: `pnpm run codegen` generates `src/_generated/provider_neon_pb.ts`, and
`NeonClaimAction`, `NeonClaimPlan`, and `NeonProvisionReceipt` are each a
`DomainView` (`src/wire.ts`) of their generated message rather than a
hand-written parallel interface. A view names only what it refines — the claim
vocabulary, the literal claim boundary, optional locators that stay absent
instead of becoming `""`, epoch milliseconds as a JSON-safe `number` — and
inherits the rest, so renaming a proto field is a compile error here rather than
silent drift. `data-models/provider_neon.cue` carries the invariants the parsers
enforce (UUID form, `neon.new` claim host, expiry after creation, at least two
claim actions, locator-shaped secret refs).

## Event architecture

This package is a strategy leaf: it holds no reducer, no stream, and no store.
Its job is to turn one provider interaction into facts the claim plane can make
durable, and the durable machinery lives in `@hobo/claims` and
`packages/hobo/src/claim-plane.ts`.

The flow for one claimable database:

1. A **command** from the claim family — `ReserveGuestLease`,
   `RecordProvisionedSubject`, `ObserveClaimItem`, `VerifyOwnership`,
   `RotateCapabilityBinding`, `ExpireGuestLease` — is what a caller issues.
   `driver.provision()`, `observe()`, `verifyOwnership()`, and
   `attestRotation()` are the effectful halves those commands invoke here.
2. `await toProviderFacts(record, publicSerialization)` returns this package's observations
   (`provider.neon.database.provisioned` / `.adopted` / `.observed`,
   `provider.neon.claim.pending-rotation` / `.completed`,
   `provider.neon.lease.expired`). They are locator-only facts, not durable
   events: the claim coordinator **actor** (`reduce` in `@hobo/claims`) is what
   turns them into the **events** `GuestLeaseReserved`,
   `ProviderSubjectProvisioned`, `ClaimStatusObserved`, `OwnershipVerified`,
   `CapabilityBindingRotated`, and `GuestLeaseExpired`.
3. `applyClaimCommand` appends the command and those events to the durable
   **event store** on the `claim:<deploymentRef>` stream under an optimistic
   `expectedSeq`, after `assertNoSecrets` has rejected any payload carrying a
   claim URL or a credential.
4. `rebuildClaimState` folds the stored command journal back into a
   **snapshot** (`ClaimPlaneSnapshot`, carrying the store sequence it was folded
   at), which is what the next append fences against.
5. `claimStatusView` is the **projection** over that snapshot — the claim-bundle
   **materialized view** with per-item deadlines and outstanding obligations —
   and it is the **read store** `hobo claim status` renders. Nothing in it is a
   Neon credential; it holds refs, hostnames, states, and instants.

The two blocking claim actions this package emits are what keep step 5 honest:
a bundle that reports complete while `neon.claim.rotate-owner-credentials` is
outstanding would be a false read model, so the projection cannot get there.

## Error codes

`NeonProviderError.code` is one of `PROVIDER_RATE_LIMITED`,
`PROVIDER_AUTH_FAILED`, `PROVIDER_CONTRACT_CHANGED`,
`PROVIDER_OPERATION_AMBIGUOUS`, `PROVISIONING_CONFLICT`, `LEASE_EXPIRED`,
`CLAIM_EXPIRED`, `CLAIM_NOT_VERIFIED`, `BINDING_ROTATION_REQUIRED`,
`MIGRATION_FAILED`, `SECRET_CUSTODY_UNAVAILABLE`. Messages are redacted at
construction.

## Usage

```ts
import {
  createFetchTransport,
  createInMemoryIdempotencyStore,
  createNeonClaimableDatabaseDriver,
  createNeonClient,
  toProvisionReceipt,
} from "@hobo/provider-neon";

const client = createNeonClient({
  transport: createFetchTransport({ fetchImpl: fetch }),
  store: createInMemoryIdempotencyStore(),
  clock: () => Date.now(),
});

const driver = createNeonClaimableDatabaseDriver({ client, custody, clock: () => Date.now() });

const record = await driver.provision({
  ref: "my-app",
  idempotencyKey: "hobo:resource:main-db:0001",
  resourceRef: "hobo://yard/demo/data/main",
});

console.log(await toProvisionReceipt(record, publicSerialization));
```

The host supplies `publicSerialization = { custody, deriveOperationKey, scope }`.
Create `deriveOperationKey` with `createClaimableOperationKeyDeriver` from
`@hobo/core` using a privately stored, version-pinned key of at least 32 random
bytes. Retain that key version and the same scope across restart; use a new
`scope.scopeId` for each deployment incarnation. Do not derive the key from a
public name or anonymous credential placeholder. Public `resourceRef` values
are scope-bound hashes, and `opaquePhysicalId` also depends on the private key.
The native database/project IDs, claim URL, endpoints, and optional binding are
available only by resolving their custody references in an authorized host.
The serializer has no public deterministic fallback.

## Tests

Fully offline; every fixture uses obviously fake values
(`ep-fake-000000…aws.neon.tech`, password `REDACTED`).

```bash
pnpm --filter @hobo/provider-neon run build
pnpm --filter @hobo/provider-neon run test
```

Run both commands after changing the generated boundary models or driver.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the Pact-shaped
boundary contract in `contracts/provider-neon-boundary.pact.json`, the
protobuf + CUE boundary shapes in `data-models/`, and the credential scan in
`test/no-secret-leak.test.ts`.

## Hosting budget execution

The anonymous create API provides no server-side idempotency key. A production
`IdempotencyStore` must implement atomic `claim(record)` and persist the claim before
network I/O. Concurrent losers observe or refuse; they do not issue a second POST.
The included in-memory store provides local CAS for tests and single-process use.
Ambiguous creates retain their intent. Reads honor `Retry-After` using the injected
clock, and the fetch adapter uses core's streaming byte cap and total deadline.

This is a data dependency. Provider status and a successful `pg_dump` do not prove
application write fencing or a safe reverse migration. Hosting moves keep it pinned
unless the app's Trails protocol supplies ownership, checkpoint and checksum evidence.

`createNeonClaimableResolver` composes the actual claimable driver with the
shared resolver protocol. Supply a durable CAS resource repository and mutation
journal, tenant/account/deployment-incarnation scope, clock, and secret custody.
The provider idempotency key derives from that entire scope and the logical
resource; a reused author key cannot adopt another deployment's database.
Creation is attempted once. A lost response keeps the attempt uncertain and
cannot trigger a second anonymous allocation. Reads use the actual provider GET
and pin the original physical id and endpoint. Claim URLs and serialized
capability bindings enter custody; persisted outcomes contain locators only.
The anonymous surface has no verified delete operation. Its native expiry is
recorded, while retirement and final usage remain separate observed conditions.
