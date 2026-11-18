# @hobo/iac-alchemy

This optional IaC adapter uses the external `alchemy` 2.0 beta.87 library. The
host supplies an Alchemy stack, runtime layer, runtime directory, target scope
and an injected financial port to `createAlchemyIacProvider`. It implements the
`IacProvider` preview, apply, destroy and refresh port; no core package imports
this adapter or the Alchemy library.
The Rivet integration is tested against `@alchemy.run/rivet` beta.87 and its
RivetKit 3 runtime dependency.
The root integration test builds its HoBo host dependencies before running, so
it can exercise the adapter from a clean checkout.
Run `pnpm --filter @hobo/iac-alchemy lint` to check the adapter's formatting and
imports before committing changes.

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
must be single portable path segments, and the program must name that physical
stack exactly. Generated logical names containing `/` are refused before
admission or provider effects until a host-authenticated mapping is available.
Case-insensitive resource-key collisions
in one target are rejected. State reads, writes and deletes are checked in each
plan, destroy and drift scope; a stored row whose own FQN differs from its key,
an unsafe rename, or an unavailable/inconsistent scan stops execution. FQNs and scope segments
are limited to 200 ASCII characters; a scan accepts at most 1,024 stored rows,
each stored row may reference at most 1,024 downstream FQNs, and replacement
history is limited to 64 rows. Exceeding a bound fails closed. A
post-admission failure retains the reservation for reconciliation. Existing
unsafe state requires a host-controlled, independently verified migration;
state already overwritten by an earlier collision cannot be reconstructed by
this check.

The host must isolate and authenticate the actual state store and its writers,
including a durable registry of stack and stage ownership. Use
`alchemyStateScopeKey(stackName, stage)` as the case-folded registry key: for
example, `Demo/Production` and `demo/production` are the same key. Two distinct
logical scopes must never share that key in the same physical store, even if
the current filesystem happens to be case-sensitive. The host must maintain the
store's lease or equivalent exclusive fencing throughout each operation; the
adapter's checks do not repair a compromised or concurrently modified store.

The host can construct that port with `@hobo/broker`'s
`createIacFinancialServices`. Pricing is optional in its options. Without it,
`assessPricing(program)` returns explicit
unavailable pricing and apply is refused. To enable financial routing, pass
`pricing: { modelId, revision, scenario, bindings }` when constructing the
financial services. Pass the resulting port to the adapter as `financial`.
`scenario` is an `@hobo/pricing` `QuoteScenario` with complete,
current financial state and explicit workload measurements; each binding is
`{ resourceId, candidateIndex }`. All resources are rated jointly. The model
is an estimate supplied by the developer, not proof of a maximum charge.

`assessPricing` returns the plan-bound inventory, pricing state and quote for
`@hobo/dispatcher`'s `rankIacTargets`. Ranking reports that it has not checked
a budget. `executeRankedIacTargets` can invoke each adapter's
`applyWithAdmission(program, requestId, expected)` in ranked order, sharing one durable
admission request across the route. It advances only after a definitive denial
without a reservation. Alternatively, call `apply` on a chosen target directly.
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
const provider = createAlchemyIacProvider({
  stack, target, runtimeLayer, runtimeDirectory, financial,
});
const assessment = await provider.assessPricing(program);
const ranking = rankIacTargets({
  tenantId, workloadRef, action: scenario.action, at: scenario.at,
  horizon: scenario.horizon,
  candidates: [{ workloadRef, inventory: assessment.inventory, pricing: assessment.pricing }],
});
const result = await executeRankedIacTargets({
  requestId: "deployment-attempt-1", ranking,
  candidates: [{ targetId: target.targetId, run: (id, expected) => provider.applyWithAdmission(program, id, expected) }],
});
```

Omit `pricing` from the financial services to obtain an explicit unavailable
assessment. `describePricingSupport` in `@hobo/provider-manifest` separately
reports which manifest plans the pricing kernel supports.

`applyWithAdmission(program, requestId?)` returns bounded string-valued stack
outputs and the broker admission receipt, including its reservation identifier
and budget disclosure. A resource-property output is supported when it refers
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

One adapter instance refuses concurrent execution of the same program. Across
instances or process restarts, the host must use the same stable request ID for
the same logical attempt so the durable admission authority can recognize a
replay. A malformed or unreadable admission receipt requires reconciliation:
the authority may already have reserved funds even if the receipt is unusable.
An instance also blocks subsequent attempts after any outcome requiring
reconciliation; the host must resolve the previous attempt before replacing it.

Plan fingerprints are bounded and include inspectable resource inputs,
bindings, state and source identity. Plans with stack actions, partial
selection, unscoped or executable output expressions, exotic values, missing
scopes, or more than 256 resources are refused. These restrictions can exclude valid Alchemy programs;
there is no automatic fallback to an unbudgeted apply. The caller owns final
usage reconciliation and can use the budget authority's settlement APIs.
