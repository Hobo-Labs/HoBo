# @hobo/iac-alchemy

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
Cloudflare components use the optional `@alchemy.run/cloudflare` beta.87 peer.
The root integration test builds its HoBo host dependencies before running, so
it can exercise the adapter from a clean checkout.
It also checks that a cloud resource actor's durable apply and destroy
generations reach the Rivet adapter's trusted route resolver unchanged. The
fixture supplies explicit financial settlement trust and a host classification.
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
