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

Alchemy beta.87 encodes `/` as `__` in local and bucket state keys, so the
adapter accepts only portable alphanumeric, dot, hyphen and underscore FQN
segments whose complete FQN round-trips through that encoding. Stack and stage
must be single portable path segments. Case-insensitive resource-key collisions
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

Plan fingerprints are bounded and include inspectable resource inputs,
bindings, state and source identity. Plans with stack actions, partial
selection, unscoped or executable output expressions, exotic values, missing
scopes, or more than 256 resources are refused. These restrictions can exclude valid Alchemy programs;
there is no automatic fallback to an unbudgeted apply. The caller owns final
usage reconciliation and can use the budget authority's settlement APIs.
