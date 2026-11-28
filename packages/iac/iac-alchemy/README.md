# @hobo/iac-alchemy

This adapter is currently a private workspace package. The imports below work
inside this repository; the package is not in the public SDK release allowlist.

This optional IaC adapter uses the external `alchemy` 2.0 beta.87 library. The
host supplies an Alchemy stack, runtime layer, runtime directory, target scope
and an injected financial port to `createAlchemyIacProvider`. It implements the
`IacProvider` preview, apply, destroy and refresh port; no core package imports
this adapter or the Alchemy library.
Each configured stack supplies its own provider layers; `runtimeLayer` supplies
the Alchemist services. A conditional choice between stacks with different
provider requirements can use a union of those requirement types.
Rivet integrations use the optional `@alchemy.run/rivet` beta.87 and
`rivetkit` 3.0.0 peers; install both when using Rivet components.
The `@hobo/iac-alchemy/rivet` entry point binds HoBo HTTP applications to
Alchemy Rivet DurableObjects. `@hobo/iac-alchemy/rivet/runtime` provides the
actor runtime without importing the IaC provider, and `@hobo/iac-alchemy/rivet/multi`
maps multiple applications to separately attested pool and runner domains.
The host must verify each source and dependency closure, authenticate requests,
and attest exclusive canonical pool and runner isolation domains across all
active stacks, maintaining ownership through deletion and reconciliation. It
must include every pool and its infrastructure in the financial inventory. The
Rivet HTTP mapper requires each resource FQN to equal its actor name, so use
distinct actor names or independently isolated stacks and pools; placing these
actors inside an Alchemy namespace is rejected. Rivet Bindle storage, queues,
topics, resource dependencies and enabled replay are rejected explicitly when
they are not supported by the mapping.
`describeAlchemyPrimitiveSupport` reports only the HTTP kinds represented by
the supplied Rivet source or sources. Those mappings are partial because they
require a matching attested source, exclusive pool, disabled replay and no
resource dependencies. A source for one HTTP kind does not authorize another.
`describeRivetPrimitiveSupport(catalog, mappers)` also explains every missing
primitive, including why a Rivet DurableStream is not a HoBo topic and why the
standalone JSON queue does not satisfy the byte-and-attribute queue port.

```ts
import { CATALOG } from "@hobo/bindles";
import {
  createRivetPrimitiveMappers,
  describeRivetPrimitiveSupport,
} from "@hobo/iac-alchemy/rivet";

const mappers = createRivetPrimitiveMappers(source); // host-attested Rivet source
const coverage = describeRivetPrimitiveSupport(CATALOG, mappers);
const topic = coverage.find((entry) => entry.kind === "topic");
// topic.status is "unsupported"; topic.reason explains the missing semantics.
```

The Rivet HTTP binding authorizes a snapshot of the actor key, HTTP method,
URL and headers before starting application code. It transfers the request
body stream to the application without buffering it; callers must not consume
the original stream after handoff. The authorization callback does not inspect
or authenticate the body.
Each Rivet source also needs an `AlchemySourceFence` and a matching entry in
the composite guard's `sourceRequirements`. The trusted host must keep the
reviewed source, complete dependency closure, module cache, build toolchain and
uploaded artifact immutable through provider completion. Its verifier checks
the exact source claim and whether that fence remains active. The adapter
rechecks the claim before pool declaration, during planning and before provider
apply; a failed check after admission retains the reservation for reconciliation.
For a reconstructed deletion, the host must independently authenticate the
prior resource state and compare its `hashAlchemyPriorState` digest with the
historical source observation before approving the plan.
Alchemy does not run the multi-pool mapper while reconstructing a deletion;
the host's plan verifier must also authenticate the affected pool and runner
ownership and maintain its fencing until deletion completes.
The AWS mapper maps a secret declaration to an Alchemy
`AWS.SecretsManager.Secret`, with a 30-day deletion recovery window and no
secret value in IaC configuration. For bounded Node.js version operations,
select `withAwsVersionedSecret(bindle, { credentials: true })` and compose
`awsVersionedSecretBindleMappers()` from `@hobo/iac-alchemy/aws/secret-mapper`.
Use `createAwsSecretStore` from `@hobo/iac-alchemy/aws/secret` with the exact
mapped secret ARN, host-issued resource and grant epochs, explicit permissions,
a synchronous verifier and the AWS credentials and HTTP Effect layer.

`put(bytes, versionId)` requires a canonical UUID persisted by the host before
dispatch. An uncertain write reports that same ID; reconcile it or retry with
the same ID and bytes. The host must authenticate the secret incarnation,
enforce IAM, fence in-flight operations during ownership changes, and protect
secret bytes and version IDs appropriately. `access` also permits pinned reads
and version listing. Values are binary and limited to 64 KiB; listing rejects
more than 100 versions, versions without canonical UUIDs or timestamps, or
versions with equal timestamps whose newest-first order cannot be established.
The bounded `AwsSecretOrdering` model checks sorting and tie rejection for three
versions; it assumes the provider reports truthful timestamps.
The provider's creation timestamps are its only ordering evidence, so equal
timestamps cannot establish which version is newer.
An `AWSCURRENT` label does not establish the order of tied older versions.
String-valued secrets and WASI bindings are not supported. HTTP applications
may use scoped secret bindings as described below.
The `AwsSecretVersions` bounded model assumes persisted IDs, provider
idempotency, trusted host verification, timeout delivery and transport
completion; it does not prove AWS behavior.

AWS DynamoDB supports an explicitly selected, bounded Node.js KV subset. Keep
its provider choice outside the Bindle: pass the neutral Bindle through
`withAwsDynamoKv(bindle, { cache: true })` and use
`awsDynamoKvBindleMappers()` from `@hobo/iac-alchemy/aws/kv-mapper`. Install the
optional `@distilled.cloud/aws` peer and use `createAwsDynamoKvStore` from
`@hobo/iac-alchemy/aws/kv` with the mapped table's physical name, AWS partition, owner account and region,
host-issued resource and grant epochs, an explicit operation allow-list, a
per-key authorization verifier, and the AWS credentials and HTTP Effect layer.
The host must authenticate the actual table incarnation and each call, never reuse a
revoked epoch, fence outstanding requests during ownership changes, and enforce
matching IAM permissions. Requests use the full table ARN. Reads are strongly consistent; keys are limited to 2,048 UTF-8
bytes and values to 256 KiB. A failed or timed-out write or delete has an
unknown outcome and requires reconciliation. Each store retains capacity for a
timed-out request until the transport settles. The HTTP binding is described
below. WASI guests, transactions and prevention of out-of-band AWS access are
not implemented. The bounded `AwsKvRuntime` model assumes the host's
verifier and transport behave as specified; it does not prove those components.
It models one bounded store and permits transport to remain in flight after a
caller times out.

For bounded Node.js S3 objects, use `withAwsS3(bindle, { assets: true })` and
`awsS3BindleMappers()` from `@hobo/iac-alchemy/aws/s3-mapper`. To combine S3
and DynamoDB on the same target, apply both target choices and pass
`awsDynamoKvBindleMappers()` to `awsS3BindleMappers`. These target views retain
the original neutral Bindle unchanged. The separate
`createAwsS3Store` runtime requires a host-authenticated bucket, owner account
and grant, per-key authorization, IAM and the AWS credentials and HTTP Effect
layer. Each operation sends S3's expected-owner condition. It
supports objects up to 1 MiB, 1,024-byte keys, at most 1,024 body chunks and
SHA-256 content-digest metadata. Failed writes and deletes have unknown
outcomes; the host must fence ownership changes and reconcile them. The HTTP
binding is described below. WASI guests, blob events, version management and
digest authentication against a separate authority are not implemented.
The runtime reports a successful write only after transport completion, even if
application code replaces `Promise.race`.
The bounded `AwsS3Objects` model uses one key and a collision-free abstract
digest. It includes out-of-band objects with foreign metadata, oversized bodies
and corrupted digests; it does not prove the hash implementation or provider.

`inspectAwsDynamoKvStore` and `inspectAwsS3Store` expose the captured immutable
grant only for a store created by this runtime instance. The grant identifies
the store; the host must still authenticate it and authorize each operation.
The store captures its allowed operations at construction, so later changes to
application array prototypes do not change the captured grant.

A Node.js HTTP host can bind the selected DynamoDB, S3 and versioned secret
stores to a Bindle application with
`createAwsBindleApplication` and read them through `awsHttpBindings(context)`
from `@hobo/iac-alchemy/aws/http-runtime`. Use `secret(name)` for a versioned
secret. The host supplies the selected Bindle, its application name, exactly
the declared stores, and a synchronous verifier that authenticates each exact
captured store grant. The runtime rejects forged stores, extra permissions and
unverified bindings, and retires scoped handles when the request ends. The
bounded `AwsHttpSecret` model checks the secret write outcome and retained
version ID across request retirement and grant revocation; it assumes one
request and write, a trusted host verifier, a captured token, provider
idempotency and transport completion. The runtime buffers responses up to 1 MiB,
1,024 chunks and 16 KiB of headers; a stalled handler keeps one of 32 capacity
slots until it settles.
The host captures one bounded, deterministic graph for runtime binding and
source registration; accessors, duplicate dependencies and missing edges fail
before application logic runs. The source resolver must synchronously create
branded stores for the exact provisioned names.
For an Alchemy AWS Web Function, create a source in the application's entry
module. The `host` below is your own authority: it creates the branded stores
for the provided physical names, verifies each grant, and supplies AWS clients.

```ts
import { defineAwsHttpSource } from "@hobo/iac-alchemy/aws/http-source";
import { startAwsHttpServer } from "@hobo/iac-alchemy/aws/http-server";

export const source = defineAwsHttpSource({
  bindle: selectedBindle, // apply the appropriate AWS target choices first
  applicationName: "web",
  environment: process.env,
  resolveStores: (bindings) => host.resolveStores(bindings),
  verifyBinding: (claim) => host.verifyBinding(claim),
});

if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
  await startAwsHttpServer(source);
}
```

Use the same source when mapping the Bindle. `main` must be the existing
canonical absolute path to that entry module. The host must verify that the
reviewed module starts this exact source, and fence the source and its complete
dependency closure throughout planning and deployment.

```ts
import { awsDynamoKvBindleMappers } from "@hobo/iac-alchemy/aws/kv-mapper";
import { awsS3BindleMappers } from "@hobo/iac-alchemy/aws/s3-mapper";
import { awsHttpBindleMappers } from "@hobo/iac-alchemy/aws/http-mapper";
import { awsVersionedSecretBindleMappers } from "@hobo/iac-alchemy/aws/secret-mapper";

const mappers = awsHttpBindleMappers({
  source,
  main,
  authType: "IamAuth",
  maxEnvironments: 2,
  rateLimit: 100,
  sourceFence: host.sourceFence,
  verifySource: (claim) => host.verifySource(claim),
}, awsVersionedSecretBindleMappers(awsS3BindleMappers(awsDynamoKvBindleMappers())));
// Pass selectedBindle and mappers to mapBindleToAlchemy and the normal
// financial planning and admission flow.
```

The required endpoint limits bound the advertised execution environments and
request rate; they do not themselves enforce a monetary budget. A supplied
financial model must cover the Web Function and all provider-managed effects,
including its execution role, logs, code assets, requests and storage. The host
must verify the inventory and model; unknown or unbounded liability remains
subject to the policy plane's explicit unpriced decision.
The financial preview checks the mapped Web Function, DynamoDB table and S3
bucket together. Missing or incomplete pricing is rejected for budget-based
routing; a fully covered quote can be ranked before any budget reservation or
provider effect. The preview test uses stub providers.

The mapper creates `AWS.Lambda.WebFunction`; the listener starts the attested
source on its supplied endpoint. The source resolves the exact mapped resource
names from the function environment and fails closed if names or grants change.
`ApplicationManaged` is also available when the application itself
authenticates every request. The host must independently enforce IAM and fence
in-flight AWS operations across grant or resource ownership changes. The
listener buffers request bodies up to 1 MiB in at most 1,024 chunks before
dispatch, accepts at most 32 concurrent ingress operations, and returns 408 on
a 10-second deadline. A timed-out ingress read retains its slot until
cancellation settles; the application runtime independently retains its slot
until a timed-out handler settles. These limits do not bound the HTTP parser,
network connections or upstream services; the host must set its own ingress
and network limits. The bounded `AwsHttpIngress` model covers dispatch,
timeout and ingress slot retention with abstract body units. It treats the
application call as complete when its response promise settles and assumes the
parser, transport, timer, cancellation and application behave as modeled.
Streaming responses, connectors and session replay are not supported.
The bounded `AwsHttpBindings` model checks request retirement, grant
revalidation and timed-out capacity. It assumes host verification and transport
behavior; it does not prove AWS, HTTP parsing, byte limits or liveness.
The model explores one application and two requests sharing one capacity slot.

Cloudflare components use the optional `@alchemy.run/cloudflare` beta.87 peer.
Import their mappings from `@hobo/iac-alchemy/cloudflare` and the application
runtime from `@hobo/iac-alchemy/cloudflare/runtime`.
The finite `model/IacGrant.tla` model checks grant epoch non-reuse, ownership,
route revocation and delayed provider effects across retirement, including
A→B→A permissions. It assumes a trusted host authenticates exclusive scope,
fences routes and any still-running provider effects, and verifies migration;
the model does not prove that the host, platform or provider enforces these
guarantees. It assumes a single durable atomic registry shared across processes
and credentials, with no resource aliases or alternate access paths; it does
not model registry crash or replay. Retirement intent alone does not close a
proxy route: old requests remain possible until its route is fenced. The
abstraction covers one resource, two
permission choices and two ownership incarnations. It checks three grant
epochs with one request for A→B→A and, separately, two epochs with two
concurrent requests for draining; it makes no liveness claim. From the
repository root, run the pinned model runner with `HOBO_TLA_TOOLS` set to the
path of the `tla2tools-1.7.4.jar` file:

```sh
node --experimental-strip-types scripts/check-iac-models.ts
```

The Cloudflare worker runtime binds a module-exported HoBo HTTP entrypoint to
declared Worker service dependencies. HoBo bucket, WASI KV and queue runtime
contracts, topics, and enabled session replay are not yet supported; the adapter
refuses those uses. An explicitly opted-in [eventual JavaScript KV subset](CLOUDFLARE-KV.md)
uses a private, permission-enforcing Worker and is not full KV profile support.
The optional KV guide describes host grant and namespace fencing requirements;
the Worker module and the mapped Bindle must use matching binding epochs.
The opt-in [bounded R2 object subset](CLOUDFLARE-R2.md) similarly binds
JavaScript Worker applications through a private proxy. It does not claim the
complete HoBo blobstore or blob-events interfaces.
`cloudflareBindleMappers` can provision native R2, KV and queue infrastructure;
it rejects their HoBo runtime operations until blob metadata and events, WASI KV
semantics, and queue deduplication and leases are implemented.
It also rejects `continuity` annotations on these resources: provisioning the
native component alone does not establish failover, backup or spending guarantees.
`describeCloudflarePrimitiveSupport` reports partial or unsupported coverage
for each supplied HoBo catalog entry with the reason.
Alchemy namespaces can separate multiple mapped Cloudflare Bindles in one
stack. Include their resulting FQNs in the admitted target and source
requirements, and migrate existing durable state before changing a namespace.
The host must also verify the actual Cloudflare account and physical namespace,
bucket and queue identities: generated names or different stack names alone do
not establish that a resource cannot be shared or adopted.
For a Vite web application, `b.web(cloudflareViteApp("apps/site"))` uses
Alchemy's Cloudflare Website.Vite component with that project-relative root.
Disable session replay explicitly; Vite resource dependencies and other web
frameworks are not currently supported. Every executable mapping requires a
host-owned `sourceFence`; its digest must match the target's source digest, and
its proof and environment digest must match the composite guard. The guard's
`sourceRequirements` must name every executable resource and source path.
The host must authenticate the complete transitive source graph, module cache,
build toolchain and exact upload, and keep them fenced from planning until the
provider completes. The callbacks attest a host-enforced guarantee; they do not
make a mutable filesystem or module cache immutable. The fence object must use
own data properties; accessor-backed or malformed authorities are rejected.
For source deletion, the host must compute `hashAlchemyPriorState` from its
independently authenticated durable record and compare it with the reported
prior-state digest. The state must be complete, stable, and inspectable without
unresolved references. Revocation after a provider effect retains the budget
hold as uncertain.
The root integration test builds its HoBo host dependencies before running, so
it can exercise the adapter from a clean checkout.
It also checks that a cloud resource actor's durable apply and destroy
generations reach the Rivet adapter's trusted route resolver unchanged. The
fixture supplies a host classification and a priced settlement verifier that
refuses every claim, so its budget holds never settle.
Its stub RunnerPool provider does not read, build or upload `main`, so the
fixture's empty source classification applies only to that stub. A production
RunnerPool that builds source must list its complete source requirements and
use an independently attested source claim; it cannot use the empty
classification.

`mapBindleToAlchemy` accepts a HoBo bindle structurally and a provider-owned
mapping for each declared primitive. The caller must also assess bindle-wide
requirements, including required and preferred capabilities, runtimes, and
labels; an unsupported, invalid, or failed assessment prevents mapping.
Mappings declare their Alchemy resource
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

Requirements, declarations, annotations and edges must be bounded, acyclic data;
the mapper copies and freezes them before invoking provider callbacks. Invalid,
accessor-backed or oversized data is rejected. The host remains responsible for
attesting callback code and captured state.
An optional `validateGraph` callback receives the complete immutable declaration
graph and dependency names before any mapper registers resources. It must return
synchronously; rejection or an asynchronous result stops the mapping. Graph
validators do not receive application entrypoints.
Only explicit registry entries count as mappings. Connector declarations are
rejected until their authorization and runtime bindings can be mapped.
`describeAlchemyPrimitiveSupport` reports supported, partial and
unsupported entries for a supplied primitive catalog, including the declared
entrypoint and annotation support.

These mappings are supplied by the provider or developer: the adapter does not
claim that every HoBo primitive has an equivalent in every Alchemy provider.
The mapper is responsible for actually implementing the declared operations,
application logic and bindings. The provider's requirement assessment and
mapping declarations are not a conformance proof.
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

Program identity and any desired `resource` declaration are snapshotted before
planning or admission. `captureAlchemyProgram` returns a frozen bounded copy
and a digest that distinguishes an absent declaration from a present one.
An own `resource` or `operationGeneration` field set to `undefined` is treated
as absent; null, accessors and malformed values are rejected.
Declarations are limited to 16,384 values, 32 nesting levels, 1,024 array
elements, 256 properties per object, 4,096 characters per string and 1 MiB of
total text; proxies, getters, sparse or decorated arrays and unknown program
fields are rejected. The host must enforce the serialized-size limit before
materializing a program as an in-process object. This layer refuses
programs with a desired declaration until a trusted host authority can bind that
declaration to the configured stack. A durable operation generation, when
present, is part of preview and execution identity.

Alchemy beta.87 encodes `/` as `__` in local and bucket state keys, so the
adapter accepts only portable alphanumeric, dot, hyphen and underscore FQN
segments whose complete FQN round-trips through that encoding. Stack and stage
must be single portable path segments. The host authenticates the mapping from
the logical program name, including names containing `/`, to the physical stack
and its exclusive state owner. Case-insensitive resource-key collisions in one
target are rejected. After a stack has been evaluated, the adapter checks its
compiled state service for plan, destroy and drift; a stored row whose own FQN
differs from its key,
an unsafe rename, or an unavailable/inconsistent scan stops execution. FQNs and scope segments
are limited to 200 ASCII characters; a scan accepts at most 1,024 stored rows,
each stored row may reference at most 1,024 downstream FQNs, and replacement
history is limited to 64 rows. Exceeding a bound fails closed. A
post-admission failure retains the reservation for reconciliation. Existing
unsafe state requires a host-controlled, independently verified migration;
state already overwritten by an earlier collision cannot be reconstructed by
this check.

Alchemy beta.87 evaluates the supplied stack program using its original state
layer before the adapter can wrap the compiled services. That program can use
`State` directly, including writing to another stack or deleting a stage during
preview, and it can perform arbitrary other effects. The host must run only
independently authenticated stack code in a sandbox that prevents any
pre-admission state mutation and isolates all credentials and resources. A
successful ownership callback alone does not provide that sandbox. The adapter
cannot enforce these requirements by wrapping the returned stack. For compiled
state operations it restricts access to the exact authorized stack and stage;
cross-stack `Output.stackRef`, unrestricted listings and state migration are
unsupported. Perform migrations separately under independently verified host
control. State identity fields are snapshotted for guarded writes, but provider
properties, attributes and other nonidentity values may still be shared by
reference. The host must fence those values, the plan and its capabilities
against concurrent mutation throughout the operation.

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
if (assessment.admissionPath.kind !== "bounded-budget") {
  throw new Error(`No bounded budget route: ${assessment.admissionPath.kind}`);
}
const outcome = await provider.applyWithAdmission(host.program, host.persistedRequestId);
const budgetAtAdmission = outcome.admission.budget;
```

The coverage report identifies each provider as quoted, unavailable, incomplete,
or unverified, and identifies the source of a quoted model. In this example,
`budgetBeforeAdmission` says no budget was evaluated or reserved. The
`bounded-budget` path requires evaluation; `budgetAtAdmission` reports the
actual evaluation and held reservation after admission. The quote scenario
must cover the declared inventory and its candidate indexes.
The host must independently verify the scope and liability of its estimate.
The host persists the request ID and reuses it for retries of the same
operation. Reconcile an uncertain route and any issued admission before
attempting another provider effect.
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
bindings. A mapper that validates the complete graph can instead use
`sharedPrimitive` to reuse an already mapped primitive without claiming a
dependency edge; it must return that primitive's exact primary resource and no
additional resources, actions or bindings. The shared resource appears once
in the mapped inventory; the mapper and host remain responsible for proving the
application binding and for accounting for all usage of that resource.
The bounded `SharedMapping` model treats graph validation as a trusted,
synchronous decision; it does not prove a provider's validator or code.
`describeAlchemyPrimitiveSupport` reports the supplied mappers' operational
coverage; it does not authenticate them, price their resources, or authorize
routing. Hosts must attest the mapping and its execution environment.

`target.stackName` is the physical Alchemy stack name and must match the
configured `Stack`; `program.stackName` is an opaque HoBo logical identifier
and may contain `/`. They need not be equal. The adapter requires
`stateOwnership` with a stable `backendRef`, an `ownershipEpoch` and a trusted
`verify` callback. Before planning, before provider effects and after provider
completion, the host must authenticate the exact tenant, logical program and
declared state backend, physical stack, stage and ownership epoch. It must also
authenticate the bounded desired resource declaration and its digest against
the target's actual stack and source, or explicitly authorize its absence for
a direct stack invocation. The plan digest binds these identities and the
declaration and operation generation; changing them cannot reuse an earlier
assessment or admission. An assessment without a generation is distinct from
every generated operation. Obtain a fresh pricing assessment and routing
expectation for each generation.
The host must verify that `backendRef` identifies the actual configured state
store; a caller-provided reference or a callback that merely returns `true` is
not evidence of ownership.

The host must isolate and authenticate the actual state store and its writers,
including a durable registry of stack and stage ownership. Use
`alchemyStateScopeKey(stackName, stage)` as the case-folded registry key: for
example, `Demo/Production` and `demo/production` are the same key. Two distinct
logical scopes must never share that key in the same physical store, even if
the current filesystem happens to be case-sensitive. The host must maintain the
store's lease or equivalent exclusive fencing before every public provider call,
including preview, pricing assessment and refresh. Hold it through the actual
completion of all work, including work that continues after a timeout, and
release it only then. Checking a registry at each callback alone cannot establish
continuous exclusivity. The adapter's checks do not repair a compromised or
concurrently modified store. Stable ownership identifies the logical scope;
the host must independently authorize each new declaration and operation
generation without treating an old declaration as permanent ownership.
The verifier must refuse an unrecognized existing scope or changed owner until
the host independently verifies and records a migration with a new ownership
epoch. Choosing a different physical name does not migrate existing state.
The scoped plan digest differs from pre-ownership adapter plans. Reconcile any
unfinished earlier admission or provider operation before switching to this
binding; the adapter does not silently reuse or migrate an older receipt.

The host can construct that port with `@hobo/broker`'s
`createIacFinancialServices`. Pricing is optional in its options. Without it,
`assessPricing(program)` returns explicit unavailable pricing. The broker
refuses apply by default; a trusted policy may instead explicitly authorize an
unbounded exposure, reported as a budget bypass with a durable hold. An
unpriced target has no cost rank. To enable financial routing, pass
`pricing: { modelId, revision, scenario, bindings }` when constructing the
financial services. Pass the resulting port to the adapter as `financial`.
`scenario` is an `@hobo/pricing` `QuoteScenario` with complete,
current financial state and explicit workload measurements; each binding is
`{ resourceId, candidateIndex }`. All resources are rated jointly. The model
is an estimate supplied by the developer, not proof of a maximum charge.

`assessPricing` returns the plan-bound inventory, pricing state and quote for
`@hobo/dispatcher`'s `rankIacTargets`. Ranking reports that it has not checked
a budget. `executeRankedIacTargets` can invoke each adapter's
`applyWithAdmission(program, requestId, expected, permit)` in ranked order,
sharing one durable admission request across the route. It advances only after a
definitive denial without a reservation. Alternatively, call `apply` on a
chosen target directly.
For a policy-authorized unpriced target, `executeUnpricedIacTarget` takes the
explicitly selected inventory and unavailable pricing, then forwards its
reviewed expectation and permit to `applyWithAdmission` without a cost rank.
The adapter replans, refuses changes, obtains host-issued liability evidence,
and requests admission before applying the exact plan under Alchemy's state
lease. Financial services include a durable budget authority, a trusted clock,
`issueLiability`, `verifyLiability` and policy `authorize` callbacks. The
adapter only knows the injected port; the broker supplies its implementation.
Evidence must be independently verified and bound to every target account,
the operation (`deploy` or `destroy`) and the quote horizon. Liability callbacks
receive the operation in the inventory. A model or its author cannot supply its own trusted bound merely
by declaring a price.

For example, after constructing the stack, target, scenario and trusted host
callbacks:

```ts
const financial = createIacFinancialServices({
  authority, now, issueLiability, verifyLiability, authorize,
  pricing: {
    modelId: "contract-2026", revision: "1", scenario,
    bindings: [{ resourceId: "service", candidateIndex: 0 }],
  },
});
const route = createDirectRoutePort({
  authority: routeAuthority,
  hashInventory: (plan: IacFinancialPlan) => {
    const hash = financial.assess(plan).inventoryHash;
    if (!hash) throw new Error("invalid target inventory");
    return hash;
  },
});
// The trusted host authenticates these facts against its durable operation journal.
const resolveRoute = async (context: IacRouteContext) =>
  host.resolveIacOperation(context);
const stateOwnership = {
  backendRef: "state:production", ownershipEpoch: "ownership:epoch-1",
  verify: (context: AlchemyStateOwnershipCheck) =>
    host.verifyAndFenceAlchemyStateOwnership(context),
};
const provider = createAlchemyIacProvider({
  stack, target, runtimeLayer, runtimeDirectory, financial, route, resolveRoute,
  stateOwnership, composite,
});
const assessment = await provider.assessPricing(program);
// Each row is scoped to the declared inventory, not a provider-wide guarantee.
for (const providerPricing of assessment.providerCoverage.providers) {
  console.log(providerPricing.providerId, providerPricing.status);
}
// Here budget is { evaluation: "not-evaluated", reservation: "not-created" }.
// admissionPath.kind says whether the next step needs a bounded budget check,
// an explicit unpriced policy check, or cannot proceed with this configuration.
console.log(assessment.admissionPath);
const ranking = rankIacTargets({
  tenantId, workloadRef, action: scenario.action, at: scenario.at,
  horizon: scenario.horizon,
  candidates: [{ workloadRef, inventory: assessment.inventory, pricing: assessment.pricing }],
});
if (!program.operationGeneration) throw new Error("missing operation generation");
const resolved = await resolveRoute({
  tenantId, deploymentId: program.deploymentId, programId: program.programId,
  resourceId: program.resourceId, logicalStackName: program.stackName, operation: "deploy",
  declarationDigest: captureAlchemyProgram(program).declarationDigest,
  operationGeneration: program.operationGeneration,
  requestId: "deployment-attempt-1",
});
const result = await executeRankedIacTargets({
  authority: routeAuthority, tenantId, operation: resolved.operation,
  requestId: resolved.requestId, ranking,
  candidates: [{ targetId: target.targetId, run: (id, expected, permit) => provider.applyWithAdmission(program, id, expected, permit) }],
});
```

Omit `pricing` from the financial services to obtain an explicit unavailable
assessment. `describePricingSupport` in `@hobo/provider-manifest` separately
reports which manifest plans the pricing kernel supports.
In `providerCoverage`, `quoted` means the complete joint target model produced
a quote; `unavailable` means no model was supplied, `incomplete` identifies
missing or invalid bindings, and `unverified` means another joint-quote check
failed. These labels do not claim independent provider prices or validate the
host inventory. If the inventory cannot be inspected, its coverage basis is
`unavailable`. The admission receipt from execution gives the actual budget
decision; an unpriced policy bypass remains explicitly unbounded.
`admissionPath` is `bounded-budget`, `unpriced-policy`, or `unavailable`;
it describes the configured next step, not an authorization or reservation.

`applyWithAdmission(program, requestId)` returns bounded string-valued stack
outputs and the broker admission receipt, including its reservation identifier
and budget disclosure. The returned receipt types distinguish priced and
unpriced admission modes. A resource-property output is supported when it refers
to a resource in the reviewed plan. If a completed apply produces outputs that
cannot fit HoBo's output contract, `APPLY_OUTPUT_UNREPRESENTABLE` reports the
held reservation and requires reconciliation. The
standard `apply` method returns only IaC outputs. Admission errors expose their
decision; an unknown apply outcome exposes the reservation identifier.
`destroyWithAdmission` returns the corresponding receipt for a destroy.

Budget reservations remain held after successful apply until the host
reconciles final usage and source retirement with the authority. Lost
acknowledgements and failed applies retain exposure and report an uncertain
outcome. Replay cannot authorize another provider call. Destroy follows the
same preview and admission sequence. Refresh reports an error if Alchemy skips a
resource instead of calling the target in sync.

Before either a priced or an unpriced apply, the financial port must
revalidate the claimed reservation against the exact current plan, trusted
clock and policy identity. A missing, failed or unavailable revalidation
retains the hold and requires reconciliation. An unpriced receipt includes the
policy decision and a signed proof that every scoped provider account is
exclusively owned until settlement and has no shared entitlements. The trusted
host must fence policy, scope and credential revocation through provider start:
the authority's check and an external provider call cannot be one transaction.
Priced admissions cannot carry unpriced policy or scope evidence; contradictory
receipts retain their hold and require reconciliation. Changed model hashes or
unpriced policy identities are likewise rejected before provider execution.

All attempts use a shared durable route authority, including direct `apply` and
`destroy` calls. Configure `route` using `createDirectRoutePort` from
`@hobo/dispatcher`, the same route authority used by the ranked dispatcher, and
a host-owned `hashInventory` that hashes the exact target inventory in the
format used by financial admission. The dispatcher supplies an attempt permit;
direct calls claim a route and attempt through the port. The adapter verifies
and atomically consumes that permit before financial admission, then verifies
the still-active attempt again immediately before provider start. Denial,
success and uncertainty are durably recorded by the route owner. A lost or
ambiguous acknowledgment requires reconciliation, not a second attempt.
The adapter captures the host's route and financial callbacks at construction;
revocation must be enforced by the host authority's durable state.
The trusted `resolveRoute` callback authenticates the actual tenant, deployment,
program, resource, operation and durable orchestrator-issued generation against
the host's operation journal. It returns a stable request ID and a signed
operation authorization shared across candidate targets. The route authority
independently verifies that authorization and pins its target-independent
SHA-256 operation ID across request IDs. The adapter refuses a permit for
another operation and resolves it again immediately before provider start;
revocation retains the financial hold for reconciliation. The host verifies
proof expiry and revocation and must not
expose the authorization to stack code. An absent generation or failed resolver
blocks execution before route or financial admission.
The generation uses the provider-neutral `IacProgram.operationGeneration` field.

One adapter instance refuses concurrent execution of the same operation and
keeps the resource fenced across later generations while its outcome is
unknown. The resolver must return the same request and operation IDs for the
same generation across targets, instances and restarts, and distinct IDs for
each new operation.
An explicit request ID passed to `applyWithAdmission` or `destroyWithAdmission`
must match the resolver's result. The trusted host issues a successor only
after verified recovery of any prior unresolved attempt. A malformed or
unreadable admission receipt requires reconciliation:
the authority may already have reserved funds even if the receipt is unusable.
An instance also blocks subsequent attempts after any outcome requiring
reconciliation; the host must resolve the previous attempt before replacing it.

Plan fingerprints are bounded and include inspectable resource inputs,
bindings, state and source identity. Pure Alchemy literal, property, named and
aggregate outputs are inspected recursively. Every target requires a trusted
`composite` host guard with an explicit, complete `sourceRequirements` array.
Use an empty array only when the host independently verifies that the whole
target has no source-bearing resources. Every
action must have its own target scope, using its Alchemy FQN as `resourceId`
and `alchemy:action:<action type>` as `resourceType`; its provider account and
product must cover the action's financial liability. The broker sees those
scopes alongside resources when assessing and admitting the target.

The guard is a trusted host boundary, separate from developer pricing models.
Its `verifyEnvironment` callback must independently authenticate the named
sandbox, source and environment digest, tenant and complete provider-account
scope. During planning it must enforce that stack code and expression
evaluation cannot mutate infrastructure or incur unaccounted charges. During
apply it must enforce that only admitted, scoped effects can execute. Its
`verifyPlan` callback must authorize the exact structural digest, operation,
scope, source classification and effect fingerprints against independently issued evidence.
The immutable `historicalResources` observation lists every resource whose plan
node has prior state, including unchanged resources, updates, replacements,
deletes, resumed creates and provider-adopted state. Each entry names the
resource FQN, current and prior types, planned action, `renamedFrom` identities
and the SHA-256 digest of the exact prior state captured in that plan. Before
allowing an effect, the host must independently authenticate the physical
resource, ownership and complete state, calculate `hashAlchemyPriorState` over
its trusted record, and compare it to the observation. A digest presented by
the plan is not independent evidence. For adoption, the host must authenticate
the observed remote resource; for a rename, Alchemy can project the old state
to the new FQN in memory, so the host must independently verify that exact
projection and all former identities or reject it. A changed prior type is
accepted only when declared as a provider alias and separately authorized by
the host. Unhashable, cyclic, oversized, incomplete or inconsistent prior state
fails closed. Existing `historicalSources` remains available for source-specific
checks and reports the same prior-state digest for a source deletion.
The host must independently classify every provider resource and verify that
the source requirements are complete, including for raw Alchemy resources;
absence of a registered source claim is not evidence that a resource has no
source. Both callbacks must remain valid through provider completion; the
adapter rechecks them after admission and after provider apply, and before and
after refresh scans. A failed or unavailable check stops execution. If a
provider already completed, its reservation remains held and the result
explicitly requires reconciliation. The adapter performs a final asynchronous
state scan followed by a synchronous reinspection of the identical plan before
provider start, with no host-verifier callbacks between that scan and start.
The host must keep the previously verified source, credentials and state-store
fences valid throughout that interval and through provider completion. The
host must also prevent asynchronous or concurrent mutation of the in-memory
native plan, its resource objects, provider definitions and captured closures
until provider completion. A callback or a synchronous reinspection alone
cannot enforce those guarantees after it returns.
For a raw source-backed Alchemy component, register its exact resource with
`registerAlchemySource(resource, { claim, verify })`; the claim must match the
host's source requirement, target source digest and guard proof. The host's
verifier must authenticate the entire source and dependency closure, build
environment and uploaded artifact and keep them fenced through completion.

The host must ensure the sandbox and captured closure state remain immutable
for the attested environment digest: a JavaScript function's source text alone
does not reveal its captures. These callbacks verify a host-provided guarantee;
they do not themselves create an operating-system sandbox. Partial selection,
unscoped references, unknown output expressions, exotic values, missing scopes
and plans exceeding 256 nodes remain refused. Action state is not included in
Alchemy's resource drift scan, so refresh of an action-bearing target reports
incomplete drift rather than claiming it is in sync. The caller owns final
usage reconciliation and can use the budget authority's settlement APIs.
These restrictions can exclude valid Alchemy programs; there is no automatic
fallback to an unbudgeted apply.

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
consumers must reconcile leases and fence their own effects. This queue does not
map HoBo's WIT queue or asynchronous durable topic ABI.
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
does not implement the HoBo WIT queue or Bindle queue dependencies.
The bounded `model/RivetHttpQueue.tla` checks one HTTP request and one enqueue
under its stated host authority, fencing and draining assumptions; it does not
prove those assumptions, the implementation or the provider.

The separate optional `@hobo/alchemy-rivet` composition package maps the
Rivet retained-log and asynchronous topic-bus actors to Alchemy
`Rivet.DurableObject` resources. Its capability profiles distinguish the two.
The scoped topic composition can bind one HTTP application and its named
asynchronous topics to a shared resource. Host-owned source, pool, storage and
authorization evidence is required.

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
`test/better-auth-session-durability.test.ts` simulates sign-in, a process
restart (SQLite file reopen), and brokered signing-secret re-resolution so
session rows and cookie integrity survive host recycle. The session file is
the harness `sessionStorePath`. `openBetterAuthSessionStore` applies the pack
migration plan's `create-table` steps from `planBetterAuthRelationalMigrations`
to that file; there is no hand-written session DDL.
`test/better-auth-cross-box-session.test.ts` shares one file-backed session
database across two Alchemy host harness instances (two boxes, one relational
URL). `test/better-auth-onboarding-steps.test.ts` chains the executable onboarding
evidence steps (construction config → bundle plan → migrations → broker wire →
first session).
`test/better-auth-secret-providers.test.ts` models Alchemy-style secret-provider
**ordering** for auth-stack CI (construction-key merge only; **no** committed
`.env` files or live Infisical — synthetic fixtures and memory `SecretsPort`
only). `test/better-auth-host-harness.test.ts` exercises a minimal Better Auth host
fixture: construction-time `HOBO_AUTH_*` dotenv-shaped keys, in-memory Alchemy
state, a file-backed `sqlite` path (the same session file, not an in-memory
database), and `@hobo/pack-better-auth` bundle planning with camp `SecretsPort`
broker wire (synthetic signing material only; no live Worker/D1 deploy).
On Linux x64 with Docker, `pnpm --filter @hobo/iac-alchemy run test:aws-emulator`
runs the mapped AWS resources and budget-routing scenarios against both the
Vercel Labs AWS emulator and the official AWS Emulator. The runner downloads
and verifies a pinned official package, copies its binary into a temporary
private image, and starts an isolated loopback-only container. The runner
removes the container and image afterward.
An existing copy of the same package may be supplied with
`HOBO_AWS_EMULATOR_PACKAGE`; its digest is still checked.
The runner includes the secret runtime and HTTP ingress, mapper, and financial
preview specifications alongside the storage and emulator tests.
The queue export scenario uses a fresh mapped queue identity for each run so
previous simulator messages cannot satisfy or obscure its delivery check.
The pricing workflow uses HoBo's routed CI runner for the simulator job, with
the same hosted fallback as the other pricing checks and a 40-minute job limit.
The bounded-model job has a 60-minute overall limit; individual model-checking
processes retain their own limits, and the CI timeout guard enforces this cap.
The bounded `model/IacGrant.tla` checks grant and fencing decisions under stated
host assumptions; it does not prove the implementation or external provider.

### Standalone Rivet asynchronous queue

`@hobo/iac-alchemy/rivet/queue` provides a separate, asynchronous JSON queue
capability built on a real RivetKit actor and Alchemy `Rivet.DurableObject`.
It is not an implementation of HoBo's synchronous core `Queue` interface or
the byte-and-attribute WIT queue port, and does not change Bindle queue support
reporting. Applications must explicitly use the async client. It is also not a
publish/subscribe topic.

The host supplies an independently authenticated authorizer for each actor
key and operation, and a trusted clock that remains monotonic across actor
migrations and does not jump ahead of real time. The actor stores messages,
idempotency keys, delivery attempts and lease state in one transactional Rivet
SQLite database per actor key. Identical enqueue retries return the original
message ID; a changed canonical JSON body or availability schedule under the
same key returns `idempotency-conflict`. HoBo's local queue currently deduplicates
by key even when a payload differs, so this opt-in capability is stricter.
Leases expire and receive a new fenced lease ID; complete, release and extend
check that ID. Completed deduplication records are retained. Each actor is
bounded to 10,000 retained messages, 100 messages per dequeue, a 24-hour lease,
and a 64-KiB JSON request. Once capacity is reached, enqueue fails explicitly;
records are never silently discarded to make space.

A lost or malformed response is `RivetAsyncQueueError` with
`code: "outcome-unknown"`. Retrying enqueue with the same key and completion
with the same message/lease are idempotent. A lost dequeue, release, or extend
response does not prove whether it committed: wait for or reconcile the lease
before issuing conflicting work. The queue only controls message delivery;
consumers must make their own external side effects idempotent or fenced.

The client bounds each call, including the complete response body, to ten
seconds. A timeout is `outcome-unknown`: it does not prove the actor stopped or
that a mutation failed. The actor also stops reading an incomplete request after
ten seconds and bounds asynchronous authorization to ten seconds before opening
its transaction. A definite policy denial is a 403; unavailable policy,
unverified ingress and request timeouts are explicit 503s. These deadlines do
not cancel a database transaction once opened; the host must operate and bound
the backing database independently. BYOB byte streams are consumed in
bounded reads; unsupported streams are refused and cancelled unless the host
independently verifies an enforced upstream bound. Rivet 3 currently constructs
a non-BYOB request stream, so a production host must provide `verifyIngress`
and enforce its supplied total and per-chunk limits across every path before
the actor receives data. For non-BYOB client response streams, the transport
must likewise supply `verifyResponseBounds` and enforce those bounds on the
entire response path. The verifiers must authenticate the deployed ingress and
transport configuration for the exact actor, operation and key; caller-supplied
headers or a configuration declaration alone are not proof. The host must bound
provider-side buffering and concurrency even for BYOB streams, and keep those
limits in force through each request and any in-flight response.

`setup()` constructs a registry; it does not start one. Keep the actor
definition, the standalone pool program, and the IaC declaration separate so
planning does not start an envoy. For example, define the actor and registry
in `jobs.ts`:

```ts
import { setup } from "rivetkit";
import { createRivetQueueActor } from "@hobo/iac-alchemy/rivet/queue";
import { host } from "./host.js";

export const jobs = createRivetQueueActor({
  actorName: "jobs",
  now: () => host.trustedClock.nowMs(),
  authorize: (request) => host.queuePolicy.authorize(request),
  verifyIngress: (claim) => host.verifyBoundedQueueIngress(claim),
});
export const registry = setup({ use: { jobs: jobs.actor } });
```

The pool's `jobs-main.ts` imports the definition and starts the envoy:

```ts
import { registry } from "./jobs.js";

registry.start();
```

The IaC declaration imports only the inert definition and gives Alchemy the
absolute path to that exact standalone main:

```ts
import { rivetAsyncQueueResource } from "@hobo/iac-alchemy/rivet/queue";
import { jobs, registry } from "./jobs.js";

// The host verifies the reviewed main starts this actor and authorizer, and
// verifies the entire source graph, physical pool and runner isolation.
const jobsResource = rivetAsyncQueueResource({
  main: absoluteJobsMainPath,
  resourceName: "jobs",
  bindleName: "queue-app",
  sourceDigest,
  sourceFence: host.immutableSourceFence,
  poolDigest,
  isolationDigest,
  poolHost,
  registry,
  binding: jobs,
  verifySource: (source) => host.verifyQueueSourceAndExclusivePool(source),
});
```

An authorized application uses a transport bound to its exact actor key:

```ts
import { createRivetAsyncQueueClient } from "@hobo/iac-alchemy/rivet/queue";

const actor = rivetClient.jobs.getOrCreate([tenantId, "jobs"]);
const queue = createRivetAsyncQueueClient({
  fetch: (path, init) => actor.fetch(path, host.attachQueueCredential(init)),
  verifyResponseBounds: (claim) => host.verifyBoundedQueueResponse(claim),
});
const accepted = await queue.enqueue("order-123", { orderId: "123" });
const [message] = await queue.dequeue(1, 30_000);
if (message) {
  await processIdempotently(message.body, message.idempotencyKey);
  await queue.complete(message.messageId, message.leaseId);
}
```

The adapter's composite plan guard must include the exact source requirement
`{ resourceId: "jobs", resourceType: "Rivet.DurableObject", bindleName:
"queue-app", applicationName: "jobs", sourceKind: "rivet-async-queue",
sourcePath: absoluteJobsMainPath }` and independently verify that inventory.
The source fence must cover the complete program, transitive dependencies,
build environment and upload through provider completion. The host's
`verifySource` must independently authenticate that the main actually starts
the same registered actor and its intended host policies in the target pool;
the registry object supplied to the IaC declaration alone cannot prove this.
The external program is restricted to one queue actor and requires a
host-verified exclusive pool. This capability does not yet wire queue
dependencies into a Bindle application. A host must fence old writers and consumers, drain
or otherwise reconcile messages, and authorize destruction before deleting or
recreating the actor: destroying its database destroys messages and deduplication
history. Provider credentials, pool isolation, source identity, durable storage,
and clock correctness remain independently verified host responsibilities.

### AWS infrastructure and financial routing

The optional AWS mapper registers Alchemy DynamoDB tables, S3 buckets, SQS queues,
SNS topics, Secrets Manager secrets, KMS keys and Cognito user pools for the corresponding
HoBo declarations. The user pool uses Alchemy's defaults; the host must configure
identity policy and clients before use. The auth mapping does not implement token
verification or session operations and rejects declarations that require them.
Official AWS Emulator tests cover priced, denied-unpriced and explicitly
authorized-unpriced admission before creating the mapped user pool.
The notification declaration maps to its own SNS topic; the base mapper does not
bind sends or subscriptions, so `notify().allow("send")` is rejected. `withAwsSnsNotification` and
`awsSnsNotificationMappers` opt a declaration into a bounded SNS send mapping.
The `@hobo/iac-alchemy/aws/notification` entrypoint provides a scoped publisher
for the resulting topic. An AWS HTTP application can bind that publisher with
`awsHttpBindings(context).notify(name)` when its declaration depends on the
selected notification. The host supplies the exact topic grant, synchronous
verifier, AWS transport and binding authorization. A valid
submission returns `accepted` only after SNS returns a receipt and the grant is
still valid. Authorization or capacity rejection means no dispatch for that
attempt; `unknown` can mean SNS accepted the message, and retry can duplicate
it. Automatic AWS retries are disabled. SNS acceptance does not guarantee
subscriber delivery; subscribers and their permissions are host-managed.
The official AWS Emulator also checks priced, denied-unpriced and authorized
unpriced admission before creating the selected notification topic, and sends
from an HTTP application through that admitted topic. Provisioning admission
does not perform a new budget check for each subsequent send.
The crypto declaration maps to a symmetric Alchemy `AWS.KMS.Key`. It does not
provide encryption, decryption, signing, verification or application bindings;
declarations requiring those operations are rejected. The host controls key
policy and deletion and must reconcile an unknown creation before retrying.
The simulator suite exercises Alchemy key reconciliation and native KMS
encryption against a pinned Moto image because the official AWS Emulator does
not currently implement KMS. This does not establish HoBo crypto runtime support.
The WebSocket mapper creates an Alchemy `AWS.ApiGatewayV2.Api` with the WebSocket
protocol and requires `sessionReplay({ enabled: false })`. It creates no routes,
integrations or application bindings and rejects all WebSocket operations.
Official AWS Emulator tests exercise priced, denied-unpriced and authorized
unpriced admission before creating that API.
Explicitly selected KV, S3, queue and secret runtimes support the bounded
operations and HTTP bindings described above; unsupported operations are
reported explicitly. Budget-based
routing requires a complete supplied pricing model. An explicitly authorized
unpriced admission instead bypasses budget evaluation and holds unbounded
exposure; uncertain partial applies retain exposure for reconciliation. The
mapping and budget outcomes are exercised against the Vercel Labs emulator and
the opt-in official AWS Emulator; these tests do not establish production
deployment or IAM behavior.

### AWS static queue schedules

The opt-in static schedule mapper creates an Alchemy `AWS.Scheduler.Schedule`
for a schedule that depends on exactly one SQS queue. Its cadence is UTC and
supports wildcard day and weekday fields, and numeric, wildcard or step minute,
hour and month fields. It rejects other cron
forms before registering resources. Supply a nonempty, valid Unicode SQS message
body and an existing Scheduler execution role for each declared schedule.
Message bodies containing Scheduler's `<aws.scheduler.` substitution prefix are
rejected so a configured body remains literal.
The mapper composes with an AWS mapper set whose entries are own data properties
and which does not already define a schedule mapper.

```ts
import { bindle, cadence } from "@hobo/bindles";
import { awsBindleMappers } from "@hobo/iac-alchemy/aws";
import { awsStaticScheduleMappers } from "@hobo/iac-alchemy/aws/schedule";

const app = bindle("repair", (b) => {
	const queue = b.queue();
	return { queue, tick: b.schedule().dependsOn(queue).with(cadence("*/15 * * * *")) };
});
const mappers = awsStaticScheduleMappers(awsBindleMappers(), {
	tick: { roleArn: "arn:aws:iam::123456789012:role/scheduler-send", input: '{"kind":"repair"}' },
});
```

Pass `app` and `mappers` to `mapBindleToAlchemy` with the normal requirement,
source and financial checks. The inventory includes both the schedule and its
queue; bounded-budget routing requires supplied pricing that covers both.
Authorized unpriced routing bypasses budget evaluation as described above. An
incomplete supplied model does not fall back to unpriced routing. The role is
an existing external resource, so the trusted host must authenticate its
account, trust policy and permission to send to the exact queue. AWS may deliver
more than once or after the scheduled minute. The mapping does not implement the
dynamic HoBo scheduler port, queue consumption, or application bindings. The
official emulator test checks resource reconciliation and message delivery; it
does not establish production timing or IAM behavior.
The bounded `AwsStaticSchedule` model covers invalid targets and configuration,
complete budget coverage, missing versus supplied models, and explicit unpriced
admission. A supplied model with incomplete coverage cannot take the unpriced
path even when policy permits unpriced execution. It treats the host's
role authentication and the financial engine's admission decision as trusted
inputs; it does not prove provider delivery or the implementation itself.

### AWS Vite websites

The AWS Vite mapper maps an assets-only web application to Alchemy's
`AWS.Website.Vite` composite. Its financial inventory includes the complete
nine-resource graph, and its source and plan fences must verify before apply.
Application dependencies and server-side rendering are not supported by this
mapping. The emulator test exercises the mapped CloudFront key-value store;
it does not deploy the complete site.

### Bounded AWS key-value runtime

The optional Node.js DynamoDB runtime supports bounded get, set and delete
operations with explicit grants. A timed-out request retains capacity until
its transport settles; uncertain mutations require reconciliation. The host
must authenticate the table incarnation and each operation, enforce AWS permissions
and fence in-flight work. Values are limited to 256 KiB to leave room for keys and
attributes within DynamoDB's item limit. If completion observation cannot be
established after an effect may have started, its capacity remains occupied.
The shared transport boundary permits at most 32 concurrent operations per
store and uses a ten-second deadline. A deadline does not stop the provider.

The optional Node.js S3 runtime supports bounded object reads, writes and
deletes with per-key grants and a one MiB object limit. The host authenticates
the bucket incarnation and IAM scope on each operation. Responses with invalid
metadata or ranges consume at most one chunk so the stream scope closes;
uncertain mutations require reconciliation.

The internal AWS queue atomic store uses a strongly consistent read and a
conditional DynamoDB write for one bounded state document. A failed conditional
write, denied disclosure, timeout, or service error reports `unknown`: an
underlying request may have committed before its response was lost. A caller
must reconcile durable operation receipts before retrying; an `unknown` result
is not proof of a conflict or of no effect. Each queue requires a dedicated,
exclusively owned table and host-verified resource epoch; deleting or recreating
that table without fencing can lose receipts or permit an ABA revision. Factory
inspection exposes the captured grant for host binding; it does not verify IAM or
the table's actual incarnation. This
storage layer does not yet implement queue messages, leases, the SQS mapping, or
component bindings. The official AWS Emulator test resets its test record and
checks conditional writes, reopening, and concurrent writers against an
Alchemy-created table.

`@hobo/iac-alchemy/aws/queue-store` exports the DynamoDB atomic store for use
with `@hobo/runtime/atomic-durable-queue` and its asynchronous component host.
The official AWS Emulator test runs a host through this store, including a lost
write response, provider reopening, redelivery and stale-lease rejection. The
store requires a dedicated table with a string `pk` partition key and exclusive,
epoch-fenced ownership. `withAwsDynamoDurableQueue` and
`awsDynamoDurableQueueMappers` from `@hobo/iac-alchemy/aws/queue-mapper` select
an Alchemy `AWS.DynamoDB.Table` for a HoBo queue. The mapper reports its 512-event
segment and 256-KiB record bounds. Financial preview must cover that table or use
an explicitly authorized unpriced path. A supplied model must account for
the expected table storage, reads and writes; individual queue calls do not run
budget admission or enforce the estimate. This is a DynamoDB queue, with no SQS
integration or automatic dead-lettering. An AWS HTTP application can declare the queue as
a dependency and access it with `awsHttpBindings(context).queue("jobs")`.
Compose `awsHttpBindleMappers` with `awsDynamoDurableQueueMappers` and configure
`defineAwsHttpSource` to resolve the mapped table name to a queue constructed
with `createAwsQueueAtomicStore` and `createAtomicDurableQueue`. The source
checks the factory identities and table name; the host must independently verify
the account, table incarnation, IAM permissions, queue limits, application grant
and pricing. The binding exposes only declared enqueue/dequeue operations and
expires with the HTTP request. A denied or revoked operation returns `unknown`
with its operation identity because an earlier attempt may have committed.
The official AWS Emulator test exercises this binding against the Alchemy-created
table, including changed table names and authorization. A trusted owner
must authorize and call the provider's `compact()` and `reclaimCompleted()`
operations when needed. Reclaiming a completed message ends its message-key
deduplication after live receipts expire. These storage reads and writes must be
included in the supplied pricing model; the owner can explicitly redrive exhausted messages after their live receipts
and final lease expire. The owner can confirm an independently verified durable
dead-letter export using the observed queue revision and destination receipt;
HoBo does not send or authenticate that export automatically.

The trusted queue owner can inspect a bounded batch of exhausted messages and
then redrive them. The observation can become stale and does not prove that an
external dead-letter export committed; the owner must fence and reconcile it.

Dead-letter confirmation is an owner operation. The host must provide a durable,
idempotent destination and verify its receipt; an unknown destination or queue
outcome requires reconciliation. Price the destination and the additional queue
reads and writes when supplying the financial model.

Official AWS Emulator tests exercise queue deployment through financial
admission: a supplied model reserves budget before table creation, missing
pricing blocks creation unless an unpriced policy explicitly authorizes it, and
an authorized unpriced deployment records unbounded exposure. This admission
applies to deployment, not individual queue calls. The priced scenario also
enqueues and receives a message through the admitted table and HoBo's
asynchronous queue host.

Owner inspection supports snapshot-bound pagination for advancing past blocked
exhausted messages. A changed queue returns `changed` and requires a restart.
