# @hobo/provider-railway

Railway as a HoBo `CloudProvider` for Examples out-of-the-box yards: an
equivalence table, Matching answers over it, a driver program per plan, and a
temporary Environment Station boundary that refuses anonymous provisioning, and
an authenticated service-deployment lifecycle over Railway's public GraphQL API.

There is no ambient `fetch`, `Date.now()`, `process.env` or filesystem access in
`src/`. The authenticated lifecycle uses an injected, guarded `HttpTransport` and
a host-owned credential resolver. Declarations remain pure.

## Authenticated hosting lifecycle

`createRailwayDeploymentClient({ projectId, environmentId, resolveCredential })`
uses project tokens through Railway's documented `Project-Access-Token` header.
Before any mutation it verifies the token's project/environment scope and the
existing service's project. Desired project/environment values must exactly match
the host-bound scope. Credentials remain locators in requests and are never
copied into results or provider error messages.

- `deployOnce(request, transport)` deploys a pinned full Git commit to an existing,
  repository-connected service through `serviceInstanceDeployV2`. It sends one
  mutation and returns its deployment ID as accepted, with readiness unconfirmed.
  The caller must persist a single-dispatch intent before calling; the API has no
  documented idempotency key. A lost reply is uncertain and must not be retried.
- `read(request, transport)` reads the exact deployment and verifies its deployment,
  service, environment and project IDs. `SUCCESS` plus a credential-free HTTPS
  endpoint establishes control-plane readiness. Application health and artifact
  integrity require the independent hosting probe; they are not inferred here.
- `stop(request, transport)` stops the pinned deployment and reads it again. Only
  Railway's `deploymentStopped` flag, documented as all instances having stopped,
  confirms retirement. A `REMOVED` history status alone does not. `serviceDelete`
  is never used because it would delete deployments in other environments too.

`railwayResolverRegistry(options)` creates and observes `railway.service/v1` deployments
through a durable single-dispatch journal. Requests name explicit project,
environment and parent `serviceId`; the physical resource is the billable native
deployment ID. First creation requires a full pinned `commitSha`, stable `operationId`,
`mutationJournal.persistence: "durable-cas"` and a host-supplied `deploymentStore`
(DurableEventStore, tenant, actor, owner fence and clock). The acknowledged native ID
is committed as generated `RailwayDeploymentIdentity` metadata before acknowledgement
of the mutation journal. Reopening reads that same ID. A lost reply without a durable
native ID remains uncertain and never triggers another deployment POST.

Creation requires an approved fresh parent service instance whose native
`latestDeployment` is null. Existing history is refused because a recent failed
deployment does not prove older instances stopped. Source and target use distinct
service parents; an in-place Railway rollout is not this staged transition protocol.
Native `url` supplies `servingEndpoint` only after scoped readiness. Native Git
`meta.commitHash` must be present, valid and match any requested pinned commit before
readiness is reported. Missing or malformed metadata leaves the deployment unready.
The observed commit is exposed as
`observedCommitSha`, never invented as an OCI `artifactDigest`; independent artifact
evidence remains required by production hosting admission. Missing history,
GraphQL errors inside HTTP 200, rate limits and ambiguous transport responses do
not manufacture readiness, absence or released financial exposure. Fixed plan,
volume, overlap and actual usage charges remain in the shared financial authority.

The API shapes were checked against Railway's official
[service guide](https://docs.railway.com/integrations/api/manage-services),
[deployment guide](https://docs.railway.com/integrations/api/manage-deployments),
and [published CLI schema](https://github.com/railwayapp/cli/blob/master/src/gql/schema.json).
Tests use hand-authored API responses; live Railway acceptance requires an isolated
project token and a registered repository-connected service.

## What the provider actually claims

| Abstract port | Railway resource class | Product | Features admitted |
|---|---|---|---|
| `compute` | `railway:service` | Railway Service | `http`, `container`, `managed` |
| `kv` | `railway:redis` | Railway Redis | `key-value`, `durable` |
| `queue` | `railway:queue` | Railway Queue | `queue` |

Three ports, and no fourth. A requirement for `data`, `bucket`, or anything
else gets `{ kind: "none" }` rather than an optimistic partial, because an
invented parity is what makes Matching place work somewhere it cannot run.

### Deliberately absent

Absences here are load-bearing: a missing structured capability fails a
`required` feature gate, while an optimistic one passes it.

| Not claimed | Why |
|---|---|
| Regions | `regions: ["global"]`. Railway does have regions; this package models none, so it will not promise one. |
| Cost | `cost.facts` is empty and `estimateCost` explicitly marks `pricingStatus: "unknown"`. Its legacy `marginalPrice: "0"` placeholder cannot attest a free resource. Financial admission needs dated, scoped quotes. |
| Temporary / agent Environment Stations | `supportsAnonymousTemporaryDeploy = false`. Railway publishes no password-free temporary-account or agent-provision API, so the call **fails closed** rather than reaching for a permanent token. |
| IaC emission | `realize` returns a driver program (`hobo.driver-program/v1`), never a Pulumi/Terraform program. |

## Parse, don't validate

`src/parse.ts` is the only place untrusted input crosses into this package, and
what comes out the other side are **derived domain types** that cannot hold the
bad case:

- `parseRailwayResourcePlan` turns a deploy plan of `unknown` provenance into a
  `RailwayResourcePlan` whose `port` is one of the three ports the equivalence
  table actually claims and whose `name` is a branded `RailwayResourceName` —
  already a DNS label, because that name becomes part of a hostname downstream
  (ADR-0130). `realize()` calls it first, so nothing after it re-checks a port
  or re-sanitizes a name.
- `parseRailwayPort` is the same question where "not mine" is a contract
  violation; `railwayPortOrUndefined` is the same question where it is a normal
  Matching answer. Splitting them is why `satisfies()` can return `none` while
  `client()` throws.
- `parseRailwayBindings` refuses a deploy output that is a document rather than
  a locator: keys must be identifiers, values a single printable line of at most
  2048 characters. A multi-line value is how a credential arrives by accident.
- Rejections are one type, `RailwayInputRejectedError`, carrying the code
  `HOBO_RAILWAY_INPUT_REJECTED` and the offending field.

`data-models/provider_railway.proto` is the design-time wire view of these
shapes and `data-models/provider_railway.cue` carries the invariants the parsers
enforce (DNS-label names, the three-row equivalence table, a partial match that
must name what is missing, `prefer`-only option blocks, an unpriced cost signal,
and a refusal that cannot claim support). The parsed types above are the
executable catalog view of that pair. Buf generation also supplies the immutable
deployment identity used by the authenticated resolver. The catalog's legacy
string-spelled views remain marked `domain-view:` where declared.

## Event architecture

This package is an adapter leaf. Its only hosted durable stream is immutable
`railway.DeploymentLocated` metadata in the host-supplied store. It owns no
financial policy, control loop, or background service.
The durable machinery is the yard placement plane in `@hobo/broker`
(`src/yard-placement/`), and what this package contributes is one honest answer
per question.

1. The **command** side of the yard family is recorded as facts rather than a
   separate type: `yard.PlacementRequested` and `yard.GenerationRequested` are
   what a caller issues. `capabilityManifest()`, `satisfies()`, `estimateCost()`,
   `realize()`, and `client()` are the pure halves those commands consult here.
2. The plane turns those answers into the **events** of the `yard.*` family —
   `yard.MatchDecided`, `yard.GenerationReserved`, `yard.GenerationProvisioned`,
   `yard.GenerationFailed`, `yard.PlacementResolved`, `yard.PlacementRejected`.
   A refused temporary Environment Station lands as a `yard.PlacementRejected`
   carrying `HOBO_TEMP_PROVISION_UNAVAILABLE`; `railwayTemporaryStationRefusal()`
   exists so that reason is data the plane can record, not an exception it has to
   catch to find out.
3. `foldYardEventStore` is the **actor** over that stream: it consumes the
   family and rebuilds `YardEventStoreState` from the durable **event store**,
   which is the SQLite-backed journal behind the ports in `@hobo/storage-sqlite`
   (ADR-0135) — one partition, one writer, appends fenced by stream head.
4. `snapshotYardEventStore` / `restoreYardEventStore` are the **snapshot** pair
   the next fold resumes from instead of replaying the whole journal.
5. `inventorySnapshotFromFold` produces `YardInventorySnapshot`, the
   **materialized view** the placement **projection** reads, and
   `YardPlacementDecisionRow` / `YardGenerationAttemptRow` are the **read store**
   rows `hobo yard status` renders. Nothing this package emits reaches those rows
   as anything but a port name, a resource class, a locator, or a refusal code.

Because the refusal is a fact rather than a silence, a projection cannot show a
Railway yard as pending a temporary station that will never arrive.

## Usage

```ts
import { createRailwayProvider, railway } from "@hobo/provider-railway";

const provider = createRailwayProvider();

provider.capabilities
  .find((capability) => capability.port === "compute")
  ?.satisfies({ port: "compute", features: ["http"] }); // { kind: "full" }

provider.realize({ name: "sessions", port: "kv" });
// { driver: { apiVersion: "hobo.driver-program/v1", driver: "railway-deploy", … } }

railway.with.service({ replicas: 2 });
// Camp/Yard-scoped provider escape, negotiation: "prefer" — never a Bindle pin
```

## Tests

Fully offline.

```sh
pnpm --filter @hobo/provider-railway test
```

`test/resolvers.test.ts` exercises the shipped API client with scoped credentials,
foreign identities, partial GraphQL errors, rate limits, lost mutation replies,
readiness transitions and positive instance-stop evidence. This is consumer
contract evidence, not a claim of live-provider verification.

`test/deployment-journal.test.ts` uses actual SQLite stores and independent
connections for create races, reopen, lost replies, acknowledgement crashes,
changed-commit refusal and exact-deployment retirement. One case runs the shipped
resolver through core's bounded fetch transport against a real loopback HTTP server.

Gates protecting this package: TypeScript (`strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the consumer-driven
contract in `contracts/provider-railway-yard-boundary.pact.json` — replayed
interaction by interaction against the real provider in
`test/boundary.contract.test.ts` — and the protobuf + CUE boundary shapes in
`data-models/`.
