# @hobo/iac-alchemy

This optional package adapts an Alchemy stack to HoBo's infrastructure provider
port. Alchemy remains an external dependency; shared HoBo packages do not import
it. Install the package's pinned Alchemy peer and its declared Effect peers in
the host application.

`mapBindleToAlchemy` accepts a HoBo bindle structurally and a provider-owned
mapping for each declared primitive. Mappings declare their Alchemy resource
types, supported operations and annotations, and whether they bind application
entrypoints. The adapter processes dependencies first, supplies their Alchemy
resources and the original entrypoint to the mapper, and rejects missing
mappings, unbound dependencies, unsupported permissions or annotations, and
cycles. The dependency kinds recorded on each declaration must agree with the
graph, including dependencies omitted from the returned bindle.
Mapping runs inside an Alchemy stack and rejects resource or action FQNs owned
outside the current Bindle with `BINDLE_IDENTITY_COLLISION`. Existing names stay
unchanged. Distinct Alchemy namespaces can separate supported mappings, but
changing one changes durable resource identity and requires a migration.
The trusted host must prevent later raw Alchemy declarations from reusing a
mapped FQN: Alchemy can silently return the registered object outside the
mapping scope. Across stacks the host must independently verify state ownership
and actual physical provider-resource isolation; distinct stack names alone do
not establish that resources cannot be shared or adopted.
Only explicit registry entries count as mappings.
`describeAlchemyPrimitiveSupport` reports supported, partial and
unsupported entries for a supplied primitive catalog, including the declared
entrypoint and annotation support.

These mappings are supplied by the provider or developer: the adapter does not
claim that every HoBo primitive has an equivalent in every Alchemy provider.
The mapper is responsible for actually implementing the declared operations,
application logic and bindings; its declarations are not a conformance proof.
Alchemy components that generate stack actions or executable plan values remain
subject to the plan-inspection restrictions below.

Create a target with `alchemyTarget({ targetId, tenantId, stackName, stage,
programResourceId, sourceDigest, inventoryEvidenceRef, resources })`. Each
resource scope names its Alchemy FQN and resource type plus its underlying
provider, account and product. Every planned resource must be present exactly
once. Target construction rejects sparse or decorated resource arrays,
accessors, proxies, unknown fields and unknown protobuf wire fields before
protobuf conversion; at most 256 resource scopes are accepted. JavaScript
cannot bound the engine's own-key enumeration for an already oversized object,
so the host must bound serialized input before materializing it in-process.
The source digest and inventory evidence are host claims: the trusted
host must verify them and execute stack code with appropriately scoped
credentials in its sandbox. Planning runs the supplied stack program, so the
adapter cannot make untrusted program code safe by inspecting the resulting
plan.

`alchemyTarget` declares the complete resource inventory and its provider,
account and product scope. `createAlchemyIacProvider` accepts that target, an
Alchemy stack, and host-supplied state, financial and execution authorities.
Planning verifies the declared inventory against the Alchemy plan. The host
must independently verify source ownership, the physical provider scope and
liability; names and developer-supplied estimates are not proofs of those facts.

The adapter follows parse, don't validate: plan inspection produces the derived
domain type `InspectedAlchemyPlan` only after checking resource scope and
fingerprintable inputs. Uninspectable plans fail before admission or execution.
The host's resource actor issues preview, apply, destroy and refresh commands;
its executor records outcome events in the event store. Materialized projections
and the read store expose those outcomes. Alchemy owns its provider-state
snapshots, while budget reservations stay in the host authority.

`assessPricing` describes the plan and financial assessment. An unavailable
model is not a zero price. Assessment and ranking do not evaluate a budget or
create a reservation. Applying or destroying requires the host's financial
admission and route authority. A host may explicitly authorize an unpriced
operation only through the broker's unpriced policy and durable exposure hold.
An invalid or incomplete model cannot use that path. Financial receipt parsing
accepts the broker's explicit entitlement kinds and settlement payload version,
and compares claims by kind, bucket and unit so separate units in one bucket do
not collide. Legacy kindless claims normalize to `allowance` for duplicate
detection and receipt comparison. Priced and explicitly bypassed apply receipts
must carry a SHA-256 `executionDigest` on the held reservation, which the
adapter preserves through revalidation; a reservation-only receipt cannot
authorize execution.

For example, a host can supply its own pricing terms for a Rivet resource.
The `host` values below are application-supplied configuration and verified
authorities, not services created by the adapter:

```ts
import { createIacFinancialServices } from "@hobo/broker";
import { alchemyTarget, createAlchemyIacProvider } from "@hobo/iac-alchemy";

const target = alchemyTarget({
  targetId: "rivet-prod",
  tenantId: host.tenantId,
  stackName: "App",
  stage: "prod",
  programResourceId: "app",
  sourceDigest: host.sourceDigest,
  inventoryEvidenceRef: host.inventoryEvidenceRef,
  resources: [{
    resourceId: "events",
    resourceType: "Rivet.DurableObject",
    providerId: host.rivetProviderId,
    providerAccountRef: host.rivetAccountRef,
    productId: host.rivetProductId,
  }],
});

const financial = createIacFinancialServices({
  ...host.financialAuthorities,
  pricing: {
    modelId: "rivet-contract",
    revision: "1",
    scenario: host.rivetQuoteScenario,
    bindings: [{ resourceId: "events", candidateIndex: 0 }],
  },
  destroyPricing: host.rivetDestroyPricing,
});

const provider = createAlchemyIacProvider({
  ...host.providerOptions,
  stack: host.alchemyStack,
  target,
  financial,
});
const assessment = await provider.assessPricing(host.program);
const providerCoverage = assessment.providerCoverage.providers;
const budgetBeforeAdmission = assessment.budget;
const outcome = await provider.applyWithAdmission(host.program);
```

The coverage report identifies each provider as quoted, unavailable, incomplete,
or unverified, and identifies the source of a quoted model. The quote scenario
must cover the declared inventory and its candidate indexes.
The host must independently verify the scope and liability of its estimate.
Destroy has its own price scenario; an apply quote is not assumed to cover it.
To use an unpriced target, omit the pricing models and configure the broker's
explicit unpriced policy and exposure authority. Admission otherwise refuses
the operation. An authorized unpriced admission bypasses budget evaluation and
holds unbounded exposure: on that ledger, bounded admissions are refused until
the exposure is reconciled, and unpriced admission is refused while a bounded
reservation is active. A quoted assessment reports budget as not evaluated;
financial admission checks the budget and creates the appropriate hold.

`mapBindleToAlchemy` accepts provider-owned primitive mappers and assesses the
Bindle's requirements, operations, annotations, dependencies and entrypoints.
It refuses missing mappings and unbound dependencies.
When two declarations share one Alchemy resource, a mapper can set
`sharedDependency` to a declared dependency's name and return that dependency's
exact primary resource. It must return no additional resources, actions or
bindings. The shared resource appears once
in the mapped inventory; the mapper and host remain responsible for proving the
application binding and for accounting for all usage of that resource.
`describeAlchemyPrimitiveSupport` reports the supplied mappers' operational
coverage; it does not authenticate them, price their resources, or authorize
routing. Hosts must attest the mapping and its execution environment.

The optional `@hobo/iac-alchemy/rivet` entry point maps one attested API, web,
or service entrypoint to an Alchemy Rivet `DurableObject`. The accompanying
`rivet/runtime` entry point binds the application handler to a Rivet actor. The
host must verify and fence the source, artifact and exclusive pool. This mapping
does not bind resource dependencies or enabled session replay. Other primitive
kinds require additional mappers; `describeRivetPrimitiveSupport` reports their gaps.
The package tests exercise an isolated local Rivet engine and Alchemy providers
with test doubles; a live cloud deployment has not been verified.

`@hobo/iac-alchemy/rivet/namespace` maps an infrastructure-only `project`
declaration to an Alchemy `Rivet.Namespace`:

```ts
import * as Redacted from "effect/Redacted";
import {
  rivetNamespaceBindleMappers,
  rivetNamespaceResourceId,
} from "@hobo/iac-alchemy/rivet/namespace";

const mappers = rivetNamespaceBindleMappers([{
  bindleName: "shop",
  resourceName: "project",
  endpoint: host.rivetEndpoint,
  namespaceName: "shop-prod",
  token: Redacted.make(host.rivetAdminToken),
}]);
const resourceId = rivetNamespaceResourceId("shop", "project");
// Include resourceId and resourceType "Rivet.Namespace" in the authenticated target inventory.
```

This mapping does not bind the project's resource ownership or dependencies.
The host must independently authenticate the control plane, namespace ownership,
inventory and pricing. Alchemy's Rivet provider cannot delete namespaces, so
HoBo refuses uncertain creation retries and namespace update, replacement,
rename, removal and destroy plans before admission. Reconcile an interrupted
creation independently; a retained namespace may continue to incur costs. Credentials
and provider state are sensitive; use a protected Alchemy state backend.
`model/RivetNamespace.tla` checks a finite abstraction of these decisions and
does not prove the TypeScript implementation or the Rivet provider.

`@hobo/iac-alchemy/rivet/queue` additionally provides an opt-in asynchronous
JSON queue backed by a Rivet actor and an Alchemy `DurableObject`. Its runtime
uses durable transactions, idempotent enqueue keys and fenced delivery leases.
The host supplies authorization, a trusted clock, source fencing and exclusive
pool verification. The actor retains at most 10,000 messages and rejects new
ones at capacity. A timeout or lost response leaves the outcome unknown;
consumers must reconcile leases and fence their own effects. This queue is not a
mapping for HoBo's WIT queue or asynchronous durable topic ABI, so
those Bindle capabilities remain unsupported.
The finite `model/RivetQueue.tla` checks queue retry, lease and completion
decisions for one key, two payloads, at most two leases and three clock values.
It assumes atomic transactions and a trusted clock; it does not prove the
TypeScript implementation, host callbacks or provider behavior.

`@hobo/iac-alchemy/rivet/kv` provides an opt-in asynchronous byte-preserving
key-value actor mapped to Alchemy's Rivet `DurableObject`. It supports get, set,
delete and exists, with bounded keys, values and storage. Its exported
`RIVET_ASYNC_KV_CAPABILITIES` reports missing operations, including listing,
compare-and-set, TTL and watches. It has no durable idempotency or automatic
retries; an uncertain write requires reconciliation. The host supplies the
source, pool and ingress authorities and enforces single dispatch. This is not
yet the synchronous HoBo WASI store or a Bindle storage dependency.
The finite `model/RivetKv.tla` checks one set or delete, a lost reply, late
commit and fenced retirement. It assumes an independently effective host fence
and does not prove the implementation, host callbacks or provider behavior.

`@hobo/iac-alchemy/rivet/http-kv` binds an HTTP application and its asynchronous
key-value actor in one Rivet program. The host must attest the exact registry,
source, transport, pool and isolation domain. HTTP authorization, storage
authorization and response disclosure remain distinct decisions, and an
uncertain write must be reconciled before retrying. This binding does not
implement the synchronous HoBo WASI store or Bindle storage dependencies.
The bounded `model/RivetHttpKv.tla` checks one HTTP request and one write under
the host authority, fencing and draining assumptions described in the model;
it does not prove those assumptions or the implementation.

`@hobo/iac-alchemy/rivet/http-queue` binds an HTTP application and its asynchronous
JSON queue actor in one Rivet program. The host must attest the registry, source,
transport, pool and isolation domain. Admission and response authorization are
separate decisions; an uncertain queue operation requires reconciliation. This
does not implement the synchronous HoBo WIT queue or Bindle queue dependencies.
The bounded `model/RivetHttpQueue.tla` checks one HTTP request and one enqueue
under its stated host authority, fencing and draining assumptions; it does not
prove those assumptions, the implementation or the provider.

The separate optional `@hobo/alchemy-rivet` composition package maps the
Rivet retained-log and asynchronous topic-bus actors to Alchemy
`Rivet.DurableObject` resources. Its capability profiles distinguish the two;
neither implements the legacy synchronous topic ABI. Host-owned source, pool,
storage and authorization evidence is required for both.

The optional `@hobo/iac-alchemy/cloudflare` entry point maps supported HoBo
declarations to Alchemy Cloudflare components, including Workers, Vite websites,
KV namespaces, R2 buckets, queues, Secrets Store secrets, D1 databases and
Flagship flags. The support
report distinguishes infrastructure provisioning from implemented runtime
operations. Resource dependencies, consistency and identity must be validated
against the exact mapping and independently attested host environment.

For an infrastructure-only `secret` declaration, pass `secrets` to
`cloudflareBindleMappers` with the Bindle and resource names, the existing
Cloudflare account and store IDs, the secret name, and an Effect `Redacted`
string value. `cloudflareSecretResourceId` gives the Alchemy resource ID for
the target inventory. The host must verify the store, account, secret ownership
and plan scope, and provide the authenticated secret fingerprint authority.
Alchemy's local state persists secret values, so use a state backend that protects
them. This mapping does not bind HoBo's runtime `put` or `access` operations.
`model/CloudflareSecret.tla` checks a bounded mapping and preview decision under
host-attested store, inventory and fingerprint assumptions; it does not prove
the implementation or Cloudflare's behavior.

The opt-in `@hobo/iac-alchemy/cloudflare/kv` and `cloudflare/r2` mappers bind
Worker JavaScript to separately authorized KV and R2 proxy resources. KV grants
are read-only or write-only and have eventual visibility; read-your-writes and
WASI guests are unsupported. R2 supports bounded object reads, writes and deletes;
blob events, presigned URLs, ranges and multipart uploads remain unsupported.
Source, resource and grant authorities must be synchronous and host-attested.
The finite `model/CloudflareGrant.tla` checks the abstract mapping decision under
those host assumptions; it does not prove the implementation or provider.

The isolation test scans selected shared runtime, Bindle, financial and policy
packages for literal Alchemy references, including escaped spellings. It does
not prove the absence of computed references or transitive dependencies.
The financial integration test builds broker, dispatcher and pricing as test
prerequisites; they are not dependencies of the adapter package.
The repository-level `test/iac-alchemy-integration.test.ts` exercise adds
ranked dispatcher execution, durable route SQLite, Rivet Alchemy resources, and
the RivetKit 3 runtime package in one host-shaped fixture. It imports the
Alchemy, Effect, Rivet and protobuf pins directly under their root-manifest
declarations (the same peer-aligned instances the adapter resolves) and builds
its pricing scenarios from `test/iac-alchemy-pricing-fixture.ts` beside it.
The bounded `model/IacGrant.tla` checks grant and fencing decisions under stated
host assumptions; it does not prove the implementation or external provider.
