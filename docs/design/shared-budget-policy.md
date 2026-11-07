---
type: Design
title: "Shared budget policy for hosting and CI"
description: "One extensible authored policy contract, shared financial admission, and workload-specific execution guarantees for hosting and CI."
tags: [hobo, budget, ci, hosting, finops, resilience]
---

# Shared budget policy for hosting and CI

Hosting and CI use the same authored `hobo.budget-policy/v1` record. The policy
describes intent; it does not supply balances, prices, native capabilities, or
permission to execute. Those facts remain owned by authenticated publishers,
transactional financial authorities and concrete execution adapters.

The common contract lives in `@hobo/core`, including generated protobuf, CUE,
strict JSON parsing, canonicalization, scoped signal keys and pure evaluation.
Hosting accepts it at `Manifest.policy.budgetPolicy`; CI accepts the same object
at `DesiredCiPolicy.budgetPolicy`, including project-file authoring. Existing
legacy ceilings intersect with the common ceiling; declaring a common policy
cannot silently select a legacy execution path.

## Rubber-duck walkthrough

Suppose a ten-minute CI host has one free minute and costs 1,000 microdollars
per paid minute. Its remaining charge is 9,000. A fully paid host costing 100
per minute costs 1,000. Calling the first choice minimum cost would be false.
`min-cost` compares complete conservative paid commitments. `maximize-credits`
explicitly prefers usable free allocation and then compares paid commitments.
The same objective reaches ranking and the relays' pre-dispatch repricing.

Suppose policy is tightened while a caller retains an old account object. The
caller is not authority: both CI stores reload durable configuration and policy
inside the admission transaction. Native execution rechecks immediately before
opening the backend. Provider, trust or policy changes during awaited reads
cannot authorize the old request.

Suppose an operator renames an offer after consuming its allowance. Offer names
are presentation identities, not credit buckets. Leases pin the actual payer;
history follows the provider/account across aliases. Removing and reintroducing
a bucket cannot restore an old observation. Retired budget periods and policy
revisions cannot reopen. Rollback uses a new revision and preserves liabilities.

Suppose hosting and CI each see 100 microdollars available and each admit 60.
Separate cached snapshots cannot enforce that shared ceiling. Common CI policy
requires a shared financial binding. Hosting and CI reserve money, payer exposure
and entitlement claims against the same Broker authority. SQLite supports local
independent connections; the asynchronous PostgreSQL authority supports shared
distributed admission. These are adapters around one economic state machine.

Suppose financial admission commits but the CI lease transaction fails. The
parent hold remains. Recovery reuses the same stable admission attempt instead
of buying another hold. Conversely, a durable cancellation before execution can
produce a positive unused-release receipt, after which a new admission attempt
can fund a repriced host. A new GitHub run attempt and a financial admission
attempt are separate identities.

Suppose cancellation races another controller's execution claim. A preliminary
lookup is insufficient. The parent authority atomically refuses unused release
after execution has been claimed. Claimed work with proven zero final usage
settles zero; a cancellation request cannot stand in for that proof.

Suppose a provider's actual bound exceeds its estimated cost. The common policy
is evaluated again against the actual quote, the current parent financial state
and store-owned measurements. A parent global ceiling alone cannot enforce a
smaller per-work or per-payer ceiling. An expected sequence fences claim against
concurrent financial changes. Proof and quote freshness are checked again after
the financial claim; expiry retains the hold and grants no execution permission.

Suppose a job times out or a reply is lost. Neither proves that native execution
stopped. Native operation identity, observed stop and final usage stay separate
from command success. Restart reconciliation observes the pinned operation and
never reruns the command. Estimated legacy usage is labeled as estimated and
cannot settle a shared financial hold as native final usage.

## Authored language

```json
{
  "schemaVersion": "hobo.budget-policy/v1",
  "tenantId": "acme",
  "budgetId": "engineering",
  "periodId": "allocation-001",
  "revision": "policy-001",
  "workloads": ["hosting", "ci"],
  "currency": "USD",
  "limitMicros": 100000000,
  "objective": "min-cost",
  "enforcement": "conservative",
  "periodKind": "manual",
  "constraints": [
    {"key": "work.cost", "workload": "*", "unit": "USD.micros", "maximum": 5000000},
    {"key": "work.duration", "workload": "ci", "unit": "ms", "maximum": 3600000},
    {"key": "work.concurrent", "workload": "ci", "unit": "count", "maximum": 4},
    {"key": "ci.attempts", "workload": "ci", "unit": "count", "maximum": 3},
    {"key": "ci.queue.duration", "workload": "ci", "unit": "ms", "maximum": 900000}
  ]
}
```

Amounts and measured quantities are nonnegative safe integers. Zero is explicit
and survives protobuf JSON serialization; an omitted limit is not unlimited.
USD is the supported monetary currency. Unknown currencies and implicit unit or
foreign-exchange conversions refuse evaluation. Credit quantities and money are
different dimensions.

`periodId` and `revision` are opaque identities, not dates or incrementing
numbers. Manual periods do not reset themselves. `fixed-window` instead requires
explicit `periodStartsAtMs` and `periodEndsAtMs`, using a half-open UTC instant
interval. The full bounded work duration must fit the funded interval. Startup,
proxy lifetime and cleanup liability cannot be hidden by a shorter command
timeout. Settlement of existing obligations remains possible after the window.

The parser rejects unknown control fields, duplicate keys including escaped
spellings, unsafe numbers, duplicate constraints and unbounded document nesting.
Canonicalization binds every control and orders sets deterministically. CI's
`budgetPolicyDigest` lease field stores the complete canonical JSON fingerprint;
it is not a SHA digest or an authentication claim. The financial request and
quote hashes bind that complete content.

## Extensible constraints

A constraint is a required ceiling over a named, unit-tagged projected metric.
Its workload selector is either `*` or a declared workload. Extensions do not
execute code from the policy. A workload adapter must supply the exact trusted
measurement or refuse the applicable constraint; an unknown metric is never
treated as optional metadata.

| Metric | Unit | Current meaning |
| --- | --- | --- |
| `work.cost` | `USD.micros` | Complete proposed financial liability; derived from the actual bound, not an independently supplied smaller number. |
| `work.duration` | `ms` | Bounded charge-bearing lifetime of the proposed work. |
| `provider.cost` | `USD.micros` | Projected spend and commitments for the exact payer named by `target`. |
| `work.concurrent` | `count` | CI work held by the owning admission authority/partition, including uncertainty. |
| `ci.attempts` | `count` | Run attempt of the original admission demand; independently submitted pipeline IDs are separate operations, not a global retry counter. |
| `ci.queue.duration` | `ms` | Age in the owning durable CI admission queue. |

All applicable constraints are conjunctive. An account at its exact ceiling
can leave another account eligible. An already recorded overrun of a required
aggregate payer constraint freezes new admission under that policy. Per-offer
ceilings remain candidate eligibility gates for ordinary provider rotation.

The common financial authority coordinates money and credits across workloads;
it does not manufacture a global execution count from local queues. A global
cross-partition concurrency metric needs an authoritative measurement. Missing
coverage refuses the constraint. Hosting likewise refuses concurrency constraints
for which its planning context supplies no observation.

## Admission and execution

1. Parse and freeze authored intent; resolve current trusted inventory, prices
   and observations. Pure planning may report `requiresNativeBound` without
   granting admission.
2. In the CI admission transaction, re-read current policy, preserve queue age,
   select a feasible candidate and derive the stable financial attempt.
3. Reserve the parent financial hold before committing the CI lease. A failure
   between databases retains the hold. This is a recovery protocol, not a claim
   of cross-database atomic commit.
4. Recheck policy, quote, full constraints and absolute deadline around awaited
   preflight work. Claim the exact reservation for the exact execution before
   any provider mutation. A stale parent sequence refuses the claim.
5. Persist the existing dispatch/native-operation intent and execute once.
   Ambiguous dispatch, allocation or stop outcomes retain local and parent
   liability; another provider is not a speculative hedge.
6. Observe the exact native operation, stop and final usage. Settlement preserves
   the original payer, credit claims and actual charge, including overruns.
7. A verified pre-allocation cancellation can release an unclaimed hold. Its
   durable parent receipt survives CI replay. Unresolved canceled or estimated
   work cannot disappear during period rollover.

Definitive pre-commit financial denial may try another eligible offer within the
same bounded admission pass. It does not create a lease or increment its funding
generation. If all candidates are denied, demand remains queued. Transport,
authentication, claim and ambiguous commit failures are not classified as this
safe fallback.

CI's complete native liability must equal its full local paid reservation. A
larger native bound is refused before parent writes: otherwise a loose shared
budget could conceal violation of a tighter CI account/provider ceiling, and
later local admissions would undercount the first hold. Trusted rate cards must
include all charge-bearing dimensions before that candidate can be admitted.

PostgreSQL acquisition, lock and statement waits are bounded. A late connection
after acquisition timeout is released without issuing SQL. Use a dedicated
financial pool when the CI transaction also needs a connection: sharing a fully
occupied one-connection pool causes a bounded admission failure rather than a
deadlock or a late write.

Native fallback retains one overall deadline. Definitive refusal before native
allocation can move to another funded attempt. A lost acknowledgment, cancellation
request or process-clock timeout cannot authorize that fallback. Persisted queue
deadlines cannot be extended by duplicate webhook delivery or controller restart.

## Guarantees and CI execution classes

`conservative` uses declared conservative commitments and records actual liability;
it does not promise that an external provider cannot exceed an estimate.
`strict` requires an authenticated provider-enforced liability bound before
mutation and again at claim. A locally configured boolean, spending alert,
estimate, timeout or cleanup plan is insufficient. Missing integration refuses
strict execution. Existing hosting production native-proof gates remain required
even when a common policy requests the weaker mode.

Official GitHub runner bridges, isolated Sandbox runners and portable command
pipelines have different capability contracts. Generic Dagger/Cloudflare policy
inventory does not establish that they host official GitHub Actions runners;
the hosted control API refuses unsupported bindings. Raw runner SDK methods and
the variable-rebalancing reference example do not replace this admission lifecycle.

A shared GitHub label permits repository-wide assignment. Ref/event filters and
`ci.attempts` govern the original demand, not selective isolation of whichever
job GitHub assigns to a host. The host's account-level financial liability stays
reserved even if a different repository job is assigned. Untrusted workloads
need the existing isolated execution path and explicit repository-wide consent.

## Signals, observations and replay

Broker v2 threshold facts bind tenant, budget, period and policy revision. Reset
cycle zero does not consume crossing cycle one. Current and old scoped watermarks
remain separate. A legacy recovery, foreign period, expired queue item or delayed
reset cannot reopen current eligibility. Zero-budget signals are valid; they do
not create free financial capacity.

Signals modify eligibility, not financial authority. The consumer verifies scope,
state arithmetic and canonical keys; authenticated observation-publisher authority
remains necessary. A producer digest's syntax alone does not authenticate it.
Station publishes scoped facts through v2 APIs instead of rewriting runtime
provider enablement or trust.

Usage with the same timestamp as a snapshot is conservatively counted: a timestamp
alone cannot prove that a later local completion was included. A strictly newer
trusted observation is needed for coverage. Same-period spend cannot be erased
by presenting a newer timestamp with a smaller total. Explicit new periods still
require all old liabilities resolved.

Journal compaction must preserve or reconstruct retired periods, bound revisions,
removed bucket observation history, immutable payer identities, attempt generations,
claim fences and positive release/settlement receipts. Keeping only the latest
configuration would discard those protections.

The [implementation and scenario record](../plans/0023-shared-budget-policy-ci.md)
links executable regressions and final validation. External CI vendor execution
requires authenticated accounts; local PostgreSQL, SQLite, HTTP and modeled
provider tests do not constitute live vendor billing certification.
