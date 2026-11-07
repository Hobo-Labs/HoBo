# @hobo/provider-convex

Thin Convex deploy-target `CloudProvider` (ADR-0144 thin-adapter rule): the
reactive TypeScript BaaS realized behind HoBo's agnostic ports with
honest-partial capability verdicts, typed impedance limits, and a
credential-gated Management API client.

## What it provides

- **Equivalence classes** (`src/equivalence.ts`): `web/service` →
  `convex:function-host`, `database/reactive` → `convex:document-db`,
  `objectStore` → `convex:file-storage`. Vector search (`search.vector`) and
  scheduled functions (`functions.scheduled`, `crons`) are capability
  *features* — HoBo has no `vector` or scheduler port today, and this package
  does not pretend otherwise.
- **Capability manifest** (`src/manifest.ts`): the four
  `/.well-known/capability-manifest/*` documents with declared public-pricing
  cost facts and a **`deploy-key-brokered`** auth posture — Convex deploy keys
  are static credentials, so the Yard broker holds them and mints short-lived
  grants; `staticSecrets: false` is enforced at parse time and no key ever
  lands in a Bindle, Camp, or this package.
- **Realization** (`src/realize.ts`): `realize(plan)` emits a `convex-deploy`
  **driver program** (`hobo.driver-program/v1`) — a closed BaaS exposes a
  deploy surface, not IaC state. Outputs use the platform's
  `${resources.<name>.outputs.<key>}` placeholders.
- **Impedance boundaries** (`src/impedance.ts`): the hard vendor limits
  (1 s query/mutation, 1 MiB documents, 10 min actions, transaction caps),
  the `document` paradigm fact, and `convexImpedanceFindings()` producing
  plan-time evidence for the PortabilityReport (ADR-0024). Narrative:
  [docs/competitors/convex.md](../../../docs/competitors/convex.md#impedance-boundaries-for-the-provider-path).
- **Management API client** (`src/management-api.ts`): injected-`fetch`,
  presence-only credential gating, fails closed with remediation when no
  broker-minted key is present.
- **Capability profile** (`src/capability-profile.ts`): `data.convex/v1` as
  frozen data — see below.
- **Hosting forms** (`src/hosting-forms.ts`): the three distinct ways a Convex
  backend can exist — see below.
- **Strong claim** (`src/strong-claim.ts`): the replacement saga as a pure
  state machine with every effect behind `ConvexMigrationDriver`.
- **Conformance profile** (`src/conformance.ts`): the check list a hosting
  form must clear before it may carry a `data.convex/v1` claim, plus a
  fail-closed `evaluateConvexConformance` fold.

## `data.convex/v1` capability profile

`DATA_CONVEX_CAPABILITY_PROFILE` is **data, not a registry**: an id, the
primitive it implements, what it refines, what it composes, its maturity, the
conformance suite it must clear, and dated source references.

| field | value |
|---|---|
| `primitive` | `data` |
| `refines` | `data.document/v1` |
| `composes` | `api.http/v1`, `realtime.websocket/v1`, `service.scheduled/v1`, `bucket.file-storage/v1` |
| `conformanceSuiteRef` | `hobo.conformance.convex-hosting/v1` |

It refines `data.document/v1` and **nothing else**. Self-hosted Convex can
persist to Postgres or MySQL, and the default container keeps state in SQLite —
neither makes Convex a relational port, because the app-facing surface is
still documents and functions. `DATA_CONVEX_NON_REFINEMENTS` records each of
those confusions with the reason it is wrong, and `explainNonRefinement()`
returns it.

## Hosting forms

Three structurally distinct records in `src/hosting-forms.ts`. Conflating them
is the failure mode the module exists to prevent.

### `convex.local-accountless/v1`

Development only. The backend runs as a subprocess of `npx convex dev`, state
lives in `.convex/` and `~/.convex/anonymous-convex-backend-state/`, and there
is no public URL. The record carries an explicit `noProductionDurability: true`
flag alongside `productionDurability: false`.

Putting a tunnel in front of it does not change any of that: `tunnel` is typed
as a **Connector** (`isCapabilityClaim: false`, `grantsDurability: false`). A
proxy changes reachability, not durability, and is never evidence for a claim.

### `convex.selfhosted-oci/v1`

The official container on infrastructure the operator owns. Verified facts:

- **Image digests**, resolved 2026-08-08 from the GHCR manifest API for the
  `:latest` tag that upstream's `docker-compose.yml` ships:
  index `sha256:240a2e91…bfa75`, `linux/amd64` `sha256:86e2a6d0…1d2c1`,
  `linux/arm64` `sha256:21ead6e5…3bf7b`. `latest` is a **mutable** tag, so
  these are a dated snapshot — which is the argument for pinning the digest
  rather than the tag. Upstream also supports pinning a `:${REV}` release tag;
  this package does not resolve a release-tag digest and therefore does not
  invent a constant for one.
- **Architectures**: `linux/amd64`, `linux/arm64` (the only platforms in the
  published image index).
- **Ports**: `3210` client/CLI API and `3211` HTTP actions ("site proxy") are
  two separate public listeners; `6791` is the optional dashboard image.
- **Persistent volume**: `/convex/data` required — with the default SQLite
  engine every document, module, index, and stored file lives there.
- **Optional external SQL**: Postgres or MySQL (`POSTGRES_URL`, `MYSQL_URL`,
  `DATABASE_URL`, `DO_NOT_REQUIRE_SSL`).
- **Optional S3-compatible object storage** for the `exports`, `files`,
  `modules`, `search`, and `snapshot-imports` bucket roles.
- **Probes**: HTTP GET `/version` on `3210`, 5 s interval, 10 s start period —
  the upstream compose healthcheck.

Config is referenced by **name plus a sensitivity marker**. The `ConfigRef`
type has no `value` field, so a plaintext secret is unrepresentable.

### `convex.cloud-sponsored-transfer/v1`

A Convex Cloud deployment created under a **named sponsor account** and
transferred to the user's own team. `anonymous: false` is explicit:
sponsor-backed is not anonymous. It requires a destination team to exist
*before* provisioning, and the sponsor's deploy keys are deleted once the
transfer lands (`npx convex deployment token delete`), with a post-transfer
probe asserting the key no longer authorizes anything.

The `deployKeyKinds` table records which credentials are revocable. Deploy
keys, preview keys, dev keys, and project tokens are. **Admin keys are not.**

## Strong claim by replacement

An admin key is documented as "an irrevocable secret baked into the deployment
when created". Any admin key HoBo, an agent, or a shared temporary backend ever
held therefore cannot be rotated away, and upgrading a temporary backend in
place can never *prove* exclusive ownership: the old authority still opens the
door forever. So `src/strong-claim.ts` treats every pre-claim authority as
**compromised** and replaces the backend instead:

temporary backend `B0` (authority `K0`) → provision a fresh owner-controlled
`B1` (fresh authority `K1`) → deploy code and config → quiesce/fence source
writes → export documents and files → import → verify → atomic logical
connector cutover → bounded rollback window → destroy `B0`, `K0`, and the
temporary artifacts.

`decideStrongClaim(state, command)` and `reduceStrongClaim(state, event)` are
pure; every effect goes through the injected `ConvexMigrationDriver`
(`provisionDestination`, `deployCodeAndConfig`, `quiesceSource`, `export`,
`import`, `verify`, `cutover`, `awaitRollbackWindow`, `destroy`). Unit-tested
invariants:

- the source stays authoritative when the import fails;
- cutover is rejected until every verification check passes;
- the source is destroyed only after cutover **and** a closed rollback window;
- a failure never reports the claim complete (the reducer refuses to apply
  `claim.Completed` once a failure is recorded);
- the old `K0` cannot access `B1` (`authorityCanAccessDestination`).

Authority is only ever an opaque broker reference. `parseAuthorityRef` rejects
anything shaped like Convex key material at the boundary, and
`assertNoAuthorityMaterial` re-scans every emitted event and receipt.

## Conformance profile

`CONVEX_CONFORMANCE_PROFILE` (`hobo.conformance.convex-hosting/v1`) lists the
checks a hosting form must clear: image boots on a supported arch, state
survives recreation, both public HTTP surfaces route, TLS valid, WebSocket
upgrade/reconnect/idle, documents survive redeploy, file storage survives
redeploy and migration, modules/indexes/search in durable storage, env and
config continuity explicit, backup consistent, restore into a **different**
backend, code and config **not** assumed to be in the data backup, scheduled
work explicitly reconciled, connector cutover atomic-or-compensating, the
historical pre-claim authority fails against the destination, source
destruction observable, and no admin key material in logs, events, plans,
receipts, fixtures, or snapshots.

`evaluateConvexConformance` is fail-closed: `unknown`, missing, and
unrecognized outcomes all block, and a single `fail` is never averaged away.

## Anonymous Temporary self-host

`provisionConvexBackendAnonymous` keeps its fail-closed rejection matrix
unchanged (`ANON_CONVEX_BACKEND_REJECTIONS`, `ConvexAnonBackendError`,
`formatAnonConvexBackendUnavailableMessage`). What changed is that the failure
message now names the three hosting forms above via
`CONVEX_ANON_ALTERNATIVE_HOSTING_FORMS` — as alternatives a human chooses, not
as automatic fallbacks. None of them is both anonymous and production-durable,
which is why none of them weakens the matrix.

## Official sources (checked 2026-08-08)

| URL | What it pinned here |
|---|---|
| [docs.convex.dev/cli/local-deployments](https://docs.convex.dev/cli/local-deployments) | local backend is a subprocess of `npx convex dev`, state in `.convex`, anonymous development, no public URL ("set up a proxy like ngrok"), not recommended for production |
| [docs.convex.dev/self-hosting](https://docs.convex.dev/self-hosting) | self-hosted runs the open-source backend, same code as cloud; FSL Apache 2.0 |
| [github.com/get-convex/convex-backend/tree/main/self-hosted](https://github.com/get-convex/convex-backend/tree/main/self-hosted) | backend `127.0.0.1:3210`, HTTP actions `127.0.0.1:3211`, dashboard `:6791`, SQLite by default, Docker volume, optional Postgres/MySQL and S3 |
| [self-hosted/docker/docker-compose.yml](https://github.com/get-convex/convex-backend/blob/main/self-hosted/docker/docker-compose.yml) | `3210`/`3211` port mapping, `data:/convex/data`, healthcheck `curl -f http://localhost:3210/version` (interval 5 s, start period 10 s), `POSTGRES_URL`/`MYSQL_URL`/`S3_STORAGE_*` env names |
| [docs.convex.dev/database/import-export/export](https://docs.convex.dev/database/import-export/export) | `npx convex export --path` produces the same zip a dashboard backup does; streaming export via the Data Sync API |
| [docs.convex.dev/database/backup-restore](https://docs.convex.dev/database/backup-restore) | backup = table documents + optional file storage in `_storage`; **excludes** code/config, pending scheduled functions, env vars; cross-deployment restore within a team; restore is destructive |
| [docs.convex.dev/cli/deploy-key-types](https://docs.convex.dev/cli/deploy-key-types) | prod/preview/dev keys, project tokens, and **admin keys are irrevocable secrets baked into the deployment**; anon admin key stored in `~/.convex/anonymous-convex-backend-state/` |

Image digests were resolved directly from the GHCR registry manifest API with
an anonymous pull token on the same date; the method is recorded on the record
itself (`image.digestVerificationMethod`). Nothing in this package is an
attestation by Convex, and nothing here implies affiliation or endorsement.

## Architecture evidence

This package follows parse, don't validate: untrusted manifest documents,
Management API payloads, and emitted driver programs become parsed derived
types (or structured errors) at the boundary — `parsePublishedManifest`,
`parseDeployment`, `assertDriverProgram`. It emits no events itself: the
provisioning lifecycle rides the platform's command → event pipeline, where
the Orchestrator's actors append `resource.*` facts to the event store and
projections / materialized views (with snapshots feeding read stores) expose
deployment state — this provider only supplies the derived driver program and
capability documents those flows consume.

## Honesty scope

Realize/IR paths are deterministic and offline. The Management API lane is
**credential-gated**: without `CONVEX_DEPLOY_KEY` (see
`describeConvexTarget`) every live call throws `ConvexCredentialsError` —
fail closed, never a stub. Registered in
[docs/design/live-provider-matrix.md](../../../docs/design/live-provider-matrix.md).

## Hosting budget execution

Static `estimateCost` values are explicitly `pricingStatus: "estimate"`; they are not
current account quotes or enforceable liability bounds. Management calls validate an
HTTPS base without credentials, query or fragment and forbid redirect following before
sending a deploy credential. Dedicated negative tests cover those boundaries.

Convex's anonymous backend matrix remains an explicit refusal where the host cannot
supply the official backend's memory and durable storage. A deployment acknowledgement
is not application health, final billing, data fencing or retirement evidence.
