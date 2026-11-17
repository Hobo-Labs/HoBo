# @hobo/dispatcher

The Dispatcher (ADR-0071): deterministic, credit/budget-aware selection across
registered providers for placement (`match.Decided`), dispatch
(`dispatch.Decided`), and traffic (`traffic-backend` category — consumed by the
stations routing control loop).

- Ranks candidates by effective marginal cost against a pinned
  `CreditLedgerView@seq` (free tiers, rate/concurrency headroom, budget caps,
  switching cost, soonest-expiring credits).
- Hard budgets and declared rate/concurrency limits remove candidates from
  eligibility. When every candidate is ineligible, no decision fact is emitted.
  Invalid facts cannot erase an explicit hard budget.
- Hysteresis requires both a savings margin and challenger-bound continuous
  evidence (`challengerProviderId`, `savingsSince`, `observedAt`) covering the
  ISO duration `dwellWindow`. Missing evidence holds an eligible incumbent;
  an ineligible incumbent cannot be held.
- Reservation ledger with CAS (`expectedSeq`) so concurrent dispatches cannot
  double-spend free headroom; reserve/confirm/release/expire emit
  `dispatch.Reservation*` facts.
- `replayDispatchDecision` replays identical inputs to a byte-identical
  decision fact.
- **`decideDispatchV2`** (schema `hobo.dispatcher/v2`) ranks registered providers
  by minimum incremental **billed** amount from `@hobo/pricing` quotes; v1
  `decideDispatch` is unchanged for credit ranking.

## Dispatcher v2

`decideDispatchV2` and `@hobo/dispatcher/v2` use schema
`hobo.dispatcher/v2`. For each candidate's `QuoteScenario`, the adapter calls
`@hobo/pricing` and ranks exact `incremental.billed` decimals under the
`min-incremental-billed` objective. Provider ID breaks equal-cost ties.
Rejected, stale, partial, unpriced, or cross-currency quotes fail closed and
never fall back to list price. `DispatchCostQuote` omits the advisory
`allocatedEffective` field. V1 source and replay behavior remain untouched; a
fixed-fixture SHA-256 golden pins the complete v1 decision.

Candidates may instead supply `pricing: pricingUnavailable(reason)` or
`pricing: developerPricing(scope, scenario)` from `@hobo/pricing`.
Unavailable pricing is rejected with `PRICING_MODEL_UNAVAILABLE`; supplied
terms are checked against the candidate provider, tenant, account and product,
and their model ID and revision accompany the ranked quote and decision fact.
The checks cover the supplied scenario, not an independently verified IaC
inventory. The v2 dispatcher ranks estimates; it does **not** apply a budget,
reserve funds or authorize a provider call. Every v2 success and rejection
reports `budget: { evaluation: "not-evaluated", reservation: "not-created" }`;
successful `dispatch.Decided` facts carry the same disclosure. Budgeted hosting still needs the
broker's trusted whole-request quote, bound, policy decision and durable hold.

`rankIacTargets` ranks whole-target assessments for one tenant, workload,
action and quote interval. It returns excluded targets and `coverage: "partial"`
when any cannot be compared or priced. Its budget disclosure says no budget
was evaluated and no reservation created; use the broker admission authority
before executing the chosen target. The caller must establish that its common
workload reference identifies equivalent work across candidates.

Ranking accepts at most 256 candidates. Before copying their inventories and
models it bounds the whole batch to 100,000 data nodes and 4,000,000 UTF-16
code units of string values and property names; repeated references count each
time. Each inventory and model also has its own pricing input limit.
Uninspectable or excessive inputs return `ROUTING_INPUT_INVALID` with no budget
evaluation or reservation; inspectable invalid models are reported alongside
the remaining comparable candidates. JavaScript must enumerate object keys
before counting them, which can allocate before these limits apply. The host
must impose independent process memory and time limits for untrusted input.

`executeRankedIacTargets` accepts a tenant, shared route authority, ranking,
and an execution callback for each ranked target. It supplies a one-use permit
and the target's inventory, model and quote hashes to each callback. The
adapter consumes that permit before admission and verifies the active attempt
again before a provider effect. The next target is tried only after an explicit
no-effect denial without a reservation is durably recorded. Denial errors must
explicitly state `requiresReconciliation: false` and
`executionOutcome: "not-started"`; an omitted or conflicting marker is
uncertain. A replay, lost
response, malformed receipt or uncertain reservation stops the route.
The result lists each attempted target and its budget disclosure. A held
reservation remains visible when provider outputs are unusable. All callbacks
for one logical request must use the same route authority, even when they use
different financial authorities. The host must also establish any shared
provider-account or entitlement ownership required by its budget authorities.

Priced execution snapshots caller data before the route claim. Denial evidence must
be own data fields; accessors, proxies, and inherited or uninspectable
reservation fields keep the result uncertain and stop fallback. A safely
identified held reservation remains visible if outputs are uninspectable.

Route callback values and direct-route plans must be plain bounded data, with
at most 100,000 visited nodes, 4,000,000 UTF-16 code units, 4,096 array
elements, and 1,048,576 code units in a single string. JavaScript resolves a
callback's promise before the dispatcher can inspect its value, so a thenable
or proxy can run code during promise assimilation. The host must treat callback
execution as a trust boundary and provide its own isolation and time limits.
Authorities and callbacks, including a method callback's original receiver,
are host-owned capabilities. The host must keep their methods, backend identity,
credentials and receiver state stable and exclusively fenced throughout a
route; snapshotting data does not freeze those capabilities or their closures.
Proxied callback and direct-route inventory hasher functions are rejected
before a route is claimed.

`runIacRoute` requires a host-issued operation identity and authorization. The
identity is a SHA-256 digest of the tenant, deployment, resource, action, and a
durable operation generation assigned by the orchestrator. All retries and
targets for that generation share the same identity; new intent receives a new
generation. The host independently authenticates the proof and binds it to the
actual program and generation. A caller cannot authorize itself by selecting a
new request or operation ID. The SQLite authority requires a trusted
`verifyOperation` callback; it pins one current request to each authenticated
operation and accepts a successor only after verified recovery grants it.

`runIacRoute` records a single durable claim for the tenant and logical request
before any target, admission policy, or provider is called. It records each
selected target and inventory before execution, and records a definitive
no-effect denial before another target can be tried. An existing running or
uncertain claim stops the route; a finished claim cannot execute again. Use a
new request ID only after an operator has reconciled any uncertain prior work.
`inspect` exposes the bounded target/inventory history without claim secrets.
The attempt permit is a capability: protect it as a credential and verify it
with the same authority before admitting and starting a provider effect.
The adapter must atomically consume each permit once before admission; an
unknown consume acknowledgement cannot be retried. Before upgrading a host from
an older route authority, stop and fence older executors: legacy permits are
marked consumed on migration, but an older executable cannot enforce that rule.

The host must authenticate the tenant, restrict access to authority mutation,
and route *every* entry point for one request through the same durable CAS
ledger. An independent ledger or an older database restore cannot enforce this
invariant. `@hobo/dispatcher/sqlite` supplies a persistent, transactionally
serialized implementation for processes sharing one local SQLite file. It
rejects SQLite's in-memory URI modes because they cannot retain route claims.
SQLite
files on separate machines are independent ledgers; distributed deployments
must provide a shared transactional implementation of `IacRouteAuthority`.
Existing route rows created before operation identities must be individually
bound by an authenticated claim for their original request; new routes for that
tenant fail closed until every legacy row is bound. Malformed identity inputs
and inconsistent lineage or active-attempt records fail closed. Transaction
inputs are copied from own data properties before owner or scope checks, so
accessors cannot redirect a checked write. Provider and billing
authorities remain responsible for their own effects and financial holds. Reconciliation requires independent evidence that the old
source cannot act again before authorizing a new request.

`CreditAccount.reservedCost` holds pending monetary exposure in the account's
declared currency, using the existing `budgetCap`/`listUnitCost` number units.
`reserve({ expectedSeq, reservationId, providerId, dimension, units, unitCost?,
switchingCost?, estimatedCost?, expiresAt? })` checks budget and capacity in the
same CAS operation. `estimatedCost` may raise the reservation to a quoted
all-in total; it cannot lower the modelled exposure. A caller must supply the
appropriate account and authoritative quote: missing accounts retain the
legacy unconstrained selection behavior and do not establish a budget guarantee.

Pending reservations debit free allowance and rate headroom, occupy one
concurrency slot, and hold paid exposure. `release` restores those quantities
once for never-started work. `start({ reservationId, committedSeq? })` marks the
hold running; its fact must commit durably **before** an external call or
outbox dispatch. A supervisor may expire a pending hold only after establishing
the execution outbox was not dispatched or has been fenced. A running hold
survives actor leases, timeout sweeps and cancellation requests; those requests
do not prove provider work stopped or billing finalized.

`confirm({ reservationId, actualCost?, providerUsageSeq?, usageFinalized?, usageEvidenceRef? })` settles cost
(defaulting to the estimate), releases concurrency and monetary holds, and keeps
used allowance/rate consumed. Actual overruns are recorded truthfully and
returned as `budgetExceeded`; confirmation never invents a refund to stay under
a cap. Importers must reconcile `providerUsageSeq` rather than charging the same
settlement again. This package is an in-memory aggregate; callers own durable
single-writer fencing, quote authority, execution start/termination and usage
reconciliation. Running work requires explicit `actualCost`,
`usageFinalized: true`, and an auditable `usageEvidenceRef`; unresolved billing retains the entire hold. Positive
provider cancellation/absence and final usage evidence are the caller's
authority to settle a running operation, including an actual cost of zero.

Reservation IDs are unique. Identical pending reserve retries return the
original commitment without another debit; changed payloads fail. Terminal or
expired IDs cannot authorize new work. The dispatch-and-reserve helper persists
its replay input in the reservation, so a retry retains the original winner.

`freeHeadroom`, when present, is the aggregate cap; `credits` are its grant
breakdown, not additional copies of the allowance. Without an aggregate the
grant balances are summed. Expiring grants require pinned `ledger.asOf` and
are consumed earliest-expiry first. `expire({ now })` advances that pinned time
monotonically through `dispatch.LedgerTimeAdvanced` before expiring holds;
release never makes an expired grant eligible again. Expiry only releases a
reservation: execution owners must stop or fence work before returning its
remaining financial exposure to the pool.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for evidence and
[`contracts/`](./contracts) for the v1 and v2 PACT boundaries.

### Recovering a blocked IaC route

`recoverIacRoute` resolves a stuck or uncertain route only after the host has
permanently fenced the old executors and all in-flight work, then obtained
provider and financial observations made after that fence. The claim records
separate non-secret evidence references, the fence establishment time, and each
later observation's time and causal fence reference. References are stored in
the audit and must not contain credentials. Equal, future, or out-of-order
observations are rejected. Timestamps alone are not proof of causal order: the
host's independent verifiers must authenticate the evidence, verify that each
observation was made after the exact fence, and bind it to the tenant, request,
operation, complete attempt history, and proposed outcome in the claim. A
verifier that merely accepts the operator's fields does not meet this contract.
The fence must prevent all old executors, credentials, and already-dispatched
work from producing future provider effects or financial exposure.

No-effect recovery requires authoritative proof that every possible reservation
is settled or released and that no new charge or effect can arise; an empty
list is valid only when the financial authority proves there are no holds or
liabilities to list. Recovery never releases or settles a reservation. It
records one successor request for a new attempt. Already-applied recovery
records the selected target and exact inventory and either its verified held or
settled reservation, or a verified `not-applicable` disposition. It never
creates a retry. Unavailable or conflicting proof leaves the original route
blocked; callers must not infer zero cost from an unavailable pricing model.

The host authorizer must bind the authenticated operator and logical
operation to the claim. Its authorization and each proof must remain valid
through the SQLite transaction's commit; a revocable remote grant requires a
transactionally fenced authorization source. The claim's deadline is at most
five minutes away, and the same trusted clock must be used by the verifier and
store. All mutations, including `store.commit`, require a trusted host boundary;
do not expose the SQLite file, generic event writer, recovery store, or
verifier callbacks directly to untrusted clients. The store rereads the entire
route and attempt history under a write lock and checks the original version
before atomically fencing route capabilities and appending the recovery audit.
Callers receive `uncertain` if the commit or its acknowledgement cannot be
established and can safely submit the same claim again after authorization.

A host can assemble a recovery claim from authenticated evidence as follows:

```ts
import { recoverIacRoute } from "@hobo/dispatcher";
import { createSqliteIacRouteRecoveryStore } from "@hobo/dispatcher/recovery-sqlite";

const store = createSqliteIacRouteRecoveryStore({ path: routeDatabasePath });
const snapshot = await store.inspect({ tenantId, requestId });
if (!snapshot) throw new Error("Unknown route");
// Host authorities establish the fence before taking either observation.
const fence = await host.fences.establishPermanentFence(snapshot);
const provider = await host.provider.observeAfterFence(snapshot, fence);
const financial = await host.finance.observeAfterFence(snapshot, fence);
const result = await recoverIacRoute({
  store,
  authorize: (claim) => host.authorizeRecovery(authenticatedOperator, claim),
  verifyFence: (input) => host.fences.verifyEvidence(input),
  verifyProvider: (input) => host.provider.verifyEvidence(input),
  verifyFinancial: (input) => host.finance.verifyEvidence(input),
}, {
  tenantId, requestId, operationId: snapshot.operationId, operatorId: authenticatedOperator.id,
  expectedVersion: snapshot.version,
  expiresAt: host.evidenceDeadline(fence, provider, financial),
  evidence: {
    fence: { ref: fence.ref, establishedAt: fence.establishedAt },
    provider: { ref: provider.ref, afterFence: fence.ref, observedAt: provider.observedAt },
    financial: { ref: financial.ref, afterFence: fence.ref, observedAt: financial.observedAt },
  },
  outcome: { kind: "no-effect", successorRequestId, reservations: financial.terminalReservations },
});
// Use the recorded successor only when result.status is recovered or replay.
```

A selected recovery uses `outcome: { kind: "selected", targetId,
inventoryHash, financial: { disposition: "held", reservationId } }` and
requires independent proof of the applied result and financial disposition.
The recovery audit and route journal must share one durable database and a
trusted writer. Hosts must use the same journal for every entry point and bind
retries to the authenticated logical operation and its recorded successor. The
orchestrator must persist a provider-neutral operation generation before routing:
all retries for that work reuse its host-authenticated operation ID, while a
new update, replacement, or recreation receives a new generation. A stable
resource-and-action ID alone cannot distinguish separate changes.
