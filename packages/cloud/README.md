# @hobo/cloud — the Yard control-plane kernel + Planner

Production package for **S2-01** (Yard kernel) and **S2-02** (Planner + Matching),
implementing [`docs/design/control-plane.md`](../../docs/design/control-plane.md).

A coherent vertical: a **Deploy command** becomes past-tense **events**, the pure
**Planner** resolves them to a content-addressed `DeploymentPlan` DAG, and a
**materialized view** (projection) reconstructs deployment state from the log.

Commercial provider pricing catalogs use `pricingCatalogHashFromCommercialRefs` in
`src/commercial-pricing.ts` (sorted product-ref digest) without altering resource
definition `catalogHashOf`.

## Budget-aware hosting placement

`plan(bindle, { deploymentId, objective: "maximize-credits", hostingBudget }, registry)`
consumes pinned `HostingPlanningInput` evidence from `data-models/hosting_planning.proto`.
It normalizes declared billing units against bounded usage and an explicit horizon,
then filters unaffordable offers before the existing deterministic matcher ranks them.
Expected cost ranks offers; conservative exposure, including fixed and transition
charges, consumes available allowance. One planning pass accounts for shared credits
and provider-account ceilings across every selected resource. Planning never reserves
money or calls a hosting provider.

Every additional transition charge names its actual billing account and cost class.
Source egress, destination overlap, cleanup and retention can therefore consume
separate account ceilings. Credits apply only to their account, financial period
and eligible classes; an empty class list covers primary usage only. Itemized
component credits require explicit class eligibility. Legacy fixed charges remain
payable even when usage is promotional. The planning corpus under
`contracts/hosting-budget-fixtures` is executed through both the generated runtime
parser and real CUE (`hosting-budget-schema.test.ts`).

Quotes require source, currency, account identity, freshness, and a liability end
inside the funded period. Calendar-month rates require their exact billing duration.
Unknown prices cannot stand in for verified free allocation. Cost objectives with
incomparable raw units require normalized evidence; unsupported objectives fail with
structured remediation. Legacy port-only planning remains available without financial
claims; a declared budget/spend cap cannot silently fall back to that lane.

Effectful `deploy()` accepts `config.budgetId` and requires an injected
`SharedHostingBudgetAuthority` with `persistence: "durable-cas"`. The authority resolves
tenant-scoped evidence and atomically reserves the whole plan before the gateway
publishes `deployment.Planned`. Its `hosting.BudgetReserved` fact records both the
deployment artifact hash and the commitment digest through the authoritative reservation.
Identical completed requests return their recorded result; foreign-tenant or changed
payload retries fail. An interrupted admission retains its reservation for reconciliation.
The `(planHash, commitmentHash)` pair binds deployment geometry and financial approval.

The shared `hobo.budget-policy/v1` language is authored at
`Manifest.policy.budgetPolicy`, the same policy record used by CI. The trusted
`HostingPlanningInput.budgetPolicy` must pin its complete canonical content.
Tenant, budget, period, revision, funding window, objective and the lower of
legacy/common ceilings are checked before placement. The policy remains in the
commitment evidence and digest. Hosting supplies `work.cost` in `USD.micros`,
`work.duration` in `ms` through the latest quoted liability, and `provider.cost`
in `USD.micros` targeted by the actual billing account, including source egress.
Applicable metrics without authoritative measurements, including
`work.concurrent`, are refused. Strict policies can be planned with conservative
estimates; production admission still requires the native liability proofs below.

The planner is deterministic and greedy in resource-name order; it does not claim a
globally optimal graph assignment. A refusal means this pass could not construct a
funded placement. Actual provider admission, quote revalidation, settlement, and
cross-process races remain the shared authority's responsibility. Provider billing
and live-cloud behavior require separately configured adapters and acceptance evidence.

## Durable hosting movement

`createHostingTransitionCoordinator` turns an approved placement into journaled
prepare, shift, verify, retire and settle operations. Each mutation is claimed by
CAS before I/O and uses one attempt. A lost acknowledgement retains its financial
hold and schedules independent observation; loading a journal performs no effects.
The adapter contract must prove operation idempotency or writer fencing, and every
mutation rechecks authoritative policy and the funded execution window.

Production adapters set `requiresDestinationLiabilityProof`. Every destination
resource then needs an approved `destinationLiabilities` record that binds the
provider, account, resource artifact, native evidence reference, maximum charge,
and expiration. Only a provider-funded zero-cost entitlement or an enforceable
finite native term qualifies. Instance limits, forecasts and a local cleanup
timer do not bound provider billing. The term must fit inside the funded horizon
and cover a prepare or shift operation's deadline. The production adapter verifies
all resource proofs before the first mutation, and progress requires independently
observed records matching the approval.

Source retirement alone cannot release the destination's financial exposure.
Settlement additionally requires `destinationLiabilityFinalized`: a surviving
target is provider-funded or its entire finite term has been finally paid.
An unfinished metered term keeps the reservation across process restarts until
final evidence arrives. A deployment without a native bound is refused before
allocation; the coordinator does not imply an unlimited operating entitlement
from a completed migration.

Existing source exposure is also immutable approval data in `sourceLiabilities`.
The production adapter checks every source resource against its actual provider,
account, artifact and native term before preparation or decommission retirement.
An optimistic retirement deadline cannot bound a source that keeps billing after
a lost response. Source and destination maximum charges together must fit the
same financial reservation; duplicate source resources and proof reuse across
resource incarnations are refused. Each account's combined exposure must also
fit its own pinned payer allocation; global headroom cannot fund another account.
The source's `sourceIncarnationId` pins its original lifetime, while the target's
transition ID names its new lifetime. Recreating identical content cannot reuse
an old lifetime's native names or authorize a delayed deletion of the replacement.
An initial deployment may declare an empty
source inventory, and the adapter contract commits whether source proof is
required. Previously unbounded source spending cannot retrospectively acquire
a hard cap from a migration request.

`intent: "decommission"` is a separate funded lifecycle for `down`, including
after a previous move settled. It requires explicit interruption approval and
trusted quote resolution with decommission intent and the incumbent plan/lifetime.
Approval may declare a zero availability floor. It runs retire → final usage → settle,
with no fictitious healthy destination or routing shift. Fresh scoped source
retirement is required; an absent source has no serving latency or capability
to report. Cancellation before retirement stops destructive I/O and retains the
hold for unused-liability reconciliation. Once retirement was dispatched,
cancellation continues observation and settlement and cannot recreate the source.

Incomplete idempotent provider operations can use the explicit
`resumeMutation(transitionId)` command. Approval must set
`maximumMutationResumes` (default zero, maximum ten), and the adapter must expose
the same durable `ResourceMutationJournal` that guards its non-idempotent HTTP
substeps. A fresh independent pending observation, current funding/policy and
owner fence are checked before another single attempt. Operation ID, digest and
financial hold stay fixed; the resume counter and deadline are journaled, with
the deadline bounded by quote expiry and the funded horizon. Native creates
cannot be repeated after an uncertain claim. Restart only observes a saved
resume intent; it never silently repeats the mutation. Mutation effects include
storage/event emission for the write journal, while observation's storage effect
is read-only.

The coordinator can adopt the gateway's existing hold through
`existingReservationId` and `financialPlanHash`. Adoption requires `targetPlanId`
to equal that original gateway DeploymentPlan's immutable `sha256` artifact hash;
a hold cannot fund a different target artifact. The shared authority atomically
binds that hold to one execution digest, so another transition cannot reuse it.
Cancellation between operations schedules compensation; cancellation during an
uncertain mutation keeps observing. Definitive absence means the adapter proved
no matching operation can still apply, and leads to compensation rather than a
mutation retry. Restored service retains outstanding target costs until cleanup
and final usage are positively observed and settled by the financial authority.

Workload `EffectSpec` and `ResilienceProfile` declarations are hashed into approval
independently of movement topology. A stateless service may perform irreversible
external actions; that does not itself mean storage is being moved. Declared
replicated or single-writer movement requires checkpoint/checksum evidence, and
single-writer movement additionally requires fencing and ownership epochs.
Once a destination accepts writes, reversal requires a proven safe reverse transfer.
Positive source retirement evidence prevents reactivation even when its surrounding
operation reports a failure. The adapter Pacts describe consumer expectations;
these tests do not attest behavior of a live cloud provider.

## Continuous Delivery plane (attested apply)

`src/cd/` is the **workload-attested, secret-free-by-construction** apply path
over a Gatekeeper-approved resolved Deployment Set — not an Argo-style controller.

Both **`mode: "simulate"`** (offline equip) and **`mode: "live"`** (injected
`IacProvider` / `Executor`) share the same contracts: attestation, short-lived
scoped credentials, Executor sandbox, secret-free status/diff, progressive
composition, and failure disposition.

1. **Resolved Set** (`createResolvedDeploymentSet`) — post-Matching plan + Gatekeeper allow.
2. **Attested apply worker** (`createAttestedApplyWorker`) — SVID + launch measurement;
   short-lived scoped credentials per resource, revoked after each step; no ambient keys.
   Live mode fails closed without injected IaC/Executor.
3. **Secret-free status/diff** — references only (`secretRef:` / `valueRef:`); closes
   ServerSideDiff-class leaks. Status after apply returns recorded scrubbed projections.
4. **Progressive composition** via Harness OpenDelivery (flag ramp ± gateway weight ±
   auto-rollback on SLO/Golden). Rollback zeros flag percent, gateway weight, and
   activates kill-switch. Optional residual analysis adapters (Flagger/Argo-shaped HTTP)
   are complete fail-soft ports.
5. **Failure path** — Incident → default **A2H** handoff (typed package + deadline
   obligation); opt-in self-heal only inside an ADR-0076 lane, proposing a Delta that
   re-enters Gatekeeper + Harness (never baseline mutation). Unknown blast radius
   fails closed to A2H.

```ts
import {
  createContractAssertedCdFixtures,
  createContinuousDeliveryPlane,
} from "@hobo/cloud";

const fx = createContractAssertedCdFixtures({ tenant: "acme" });
const plane = createContinuousDeliveryPlane({ mode: "simulate" });
const result = await plane.deliver(fx.set);
// result.apply.principal.attestationState === "attested"
// result.apply.secretFree === true
// result.apply.activeCredentialsAfter === 0
```

CLI: `hobo deploy status|logs|rollback`, `hobo incident status|open` — each drives
the shipped plane (real deliver events for logs; real A2H/self-heal dispositions).

## Architecture

- **Gateway** (`src/gateway/`) — command ingress. Authenticates + authorizes the
  principal, turns a `Deploy` command into facts, and serves read models.
  Commands are never stored; only past-tense events are appended.
- **Store** (`src/store/`) — the core **EventStore** port (an append-only event
  store) backed by runtime-local's sqlite engine in tests (Decision D6). The
  aggregate write path runs as a single-writer **actor** via the ActorHost lease.
- **Projections** (`src/projections/`) — built on `@hobo/data`'s `defineProjection`.
  The **DeploymentView** read store rebuilds from zero; a **snapshot** is only a
  cache, never a source of truth. Emits `projection.*`.
- **Registry** (`src/registry/`) — a catalog **projection** over provider
  `capabilityManifest()` publications (Decision D2), plus the `PlannerRegistry`
  the Planner consults.
- **Planner** (`src/planner/`) — the pure function
  `plan(bindle, config, registry) → DeploymentPlan` (6 steps): lower manifest IR →
  `ResourceIntent`; collect bind-edge DAG; resolve a Resource Definition per
  resource (recording `match.Decided`); capability negotiation via the provider
  `Capability.satisfies`; region/colocation; min-cost objective ranking with a
  stable tiebreak. Unsatisfiable resources emit `deployment.PlanRejected` with a
  machine-readable remediation.

### Records: parse, don't validate

Records, messages, data shapes, and objects are defined in protobuf
(`data-models/cloud.proto`) with CUE constraints (`data-models/cloud.cue`). The
TypeScript domain types are **parsed derived types** (parse, don't validate): the
constructors in `src/plan-types.ts` are the only way to build a plan value, so
downstream code never re-validates a raw record.

### Event catalog

`deployment.Requested` · `match.Decided` · `deployment.Planned` ·
`deployment.PlanRejected` · `provider.Registered` (per-resource subjects like
`match.Decided:<resource>` are carried in the fact body, since the core envelope
type pattern forbids a colon in the type string).

## Gates

```sh
unset NODE_OPTIONS
pnpm --filter @hobo/cloud run build      # tsc
pnpm --filter @hobo/cloud run test       # vitest
pnpm run architecture:guard              # boundary/records/PACT evidence
```
