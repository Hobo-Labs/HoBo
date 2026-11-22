# `@hobo/backend-fleet`

A fleet selects one active backend and decides when to move it. This package
owns the shared assignment register, usage units, and routing policies.
PostgreSQL fleets provide SQL-backed replicas through `@hobo/data-postgres`;
cache fleets use `EphemeralStatePort` replicas.

## What this package owns

| Concern | Entry point |
|---|---|
| Assignment entries and their identity | `parseFleetAssignment`, `assignmentKey`, `fleetMajority` |
| The register over any replica | `AssignmentReplica`, `resolveAssignment`, `readCurrentAssignment`, `proposeAssignment`, `bootstrapAssignment`, `completeAssignment`, `overrideAssignment` |
| The register on a cache | `ephemeralAssignmentReplica`, `ephemeralAssignmentRegister`, `rejoinAssignmentReplicas` |
| Bounded immutable journal and generation handover | `createImmutableJournal`, `createImmutableJournalRollover` |
| Billing periods and usage units | `billingPeriod`, `FLEET_USAGE_UNITS` |
| Keep, switch or fail over a database fleet | `decideFleet`, `parseFleetFinancialModel`, `parseFleetPolicy` |
| Route a loss-tolerant fleet by budget | `routeFleetByBudget`, `parseFleetOffer`, `parseFleetRoutingMarks` |

## The register

Every member keeps an append-only log; an epoch is decided when a majority of
the configured members hold the same entry for it, and the current assignment
is the highest decided epoch. Three local rules carry the safety: one entry
per epoch, only `top + 1`, and an entry naming a writer is written to that
writer first. A reader with fewer than a majority of answers, or whose
newest epoch is not decided, gets `no-majority` or `undecided`, never a guess.
A **sealed** entry (a move in flight) names a target and lets nobody write.

### On a cache

`ephemeralAssignmentReplica(state, id, { key })` keeps one member's log in one
key of its ephemeral-state store: a `FleetAssignmentLog` (protobuf JSON) of the
newest 32 entries. `accept` reads the key, applies the rules to what it read
(`duplicate`, `conflict`, `gap`), and writes the longer log with `putIfAbsent`
(no log yet) or `compareAndSet` on the version it read, so two writers racing
on one backend cannot both extend it; the loser re-reads. Every write sets the
port's 30-day TTL cap, and `refresh` resets it (the relay's repair tick calls
it on every member).

A cache may lose the key (expiry, a flush, eviction). A lost log reads as
empty: the member stops counting as a holder of anything. Losing the log of a
minority after a decided entry has been copied to all members does not change
that decision. If a member of a bare majority loses its log while another
holder is unavailable, however, reachable empty members cannot distinguish
this loss from a new fleet. Do not bootstrap from an empty cache quorum without
independent evidence that the fleet is new. `rejoinAssignmentReplicas` seeds an
emptied member with the current entry only when a majority of all members
other than itself hold it as their newest, which ordinary repair cannot do
once old epochs have been trimmed from every log.

### Immutable journal

`createImmutableJournal` builds a bounded command log on durable replicas
using the assignment register. Its anchor binds the fleet to its ordered
provider, account, resource and incarnation identities; a majority must agree
on each entry. Bootstrap requires independent evidence that members are fresh,
and each operation calls the host's authorization hook. A host must also verify
failure domains, fund provider calls, quarantine restored replicas and fence
external effects; the journal itself does not establish those properties or
implement `DurableEventStore`.

`createImmutableJournalRollover` uses an independently anchored control
journal to choose a handover, seals the source generation and transfers its
bounded history to the destination. It does not take an application snapshot
or by itself authorize a production cutover.

## Budget routing

`routeFleetByBudget` is for a fleet whose state may be lost, so a move needs no
copy and has no lag to judge: free, then prepaid, then the cheapest
pay-as-you-go member; the active member is left when it is projected to reach
`switchAt` (default 90%) of an allowance it would stop at, or would exceed its
budget cap; any other member is a candidate only below `switchBackBelow`
(default 80%), so a member left for its allowance is not chosen again within
the month. A move for preference alone needs a cheaper tier or month and
waits out `minDwellMs`. No cap means no money. A member failing longer than
`failoverAfterMs` is left for the best reachable one that is not past a stop
or a cap. Unknown is never a reason to move. `decideFleet`, the database
fleet's policy, is unchanged.

## Continuity plans

`continuityFleetPlan(policy)` turns a Bindle's declared `continuity` trait
(`@hobo/bindles`) into what every fleet engine runs on:

- `fleet`: the `FleetPolicy` for `decideFleet`, with RPO = the declared
  recovery point and the declared failover delay. `continuous` keeps the cost
  signals (switch before a hard allowance runs out, with hysteresis and a
  one-hour dwell); `on-failure` never makes a planned switch.
- `standbys`: what placement asks for beside the writer.
- `copy` / `copyEveryMs`: `snapshot` standbys are copied every half recovery
  point (never more often than 15 s, since each copy costs reads and writes);
  `rebuildable` state is `cold` and is not copied. `decideFleet` only fails
  over to a standby copied within the RPO, so a `cold` plan is for an engine
  that starts its next member empty (the relay's cache fleet).
- `continuityBudgetCheck(plan, host?)`: holds the fleet to its declared monthly
  ceiling before the host's own budget engine decides.
- `continuityShortfalls(plan, running)`: reports when the running fleet cannot
  keep the promise (too few standbys, a tick slower than the copy cadence, no
  quorum to fail over without the operator, every member on one vendor). If
  the caller cannot verify vendor diversity, it reports that uncertainty.

A copy is one transaction and a move is a sealed register entry, so the next
tick can complete or undo interrupted control-plane work. This alone does
not fence writes or prove data continuity. Schema:
`data-models/backend_fleet.{proto,cue}` `ContinuityFleetPlan`.

## Gates

- **TypeScript:** `pnpm --filter @hobo/backend-fleet run build`.
- **Protobuf + CUE:** `data-models/backend_fleet.proto` (the assignment entry
  and log, usage, observations, financial models, offers, marks, decisions and
  routes) with `backend_fleet.cue` constraining every message;
  `src/_generated/` is generated by `pnpm run codegen`. Parse, don't
  validate: the TypeScript records are parsed derived types —
  `parseFleetAssignment`, `parseFleetFinancialModel`, `parseFleetOffer` and
  `parseFleetRoutingMarks` are the only ways in, and a stored log that does
  not parse is a failure, never an empty log.
- **PACT:** [`contracts/ephemeral-assignment-replica.pact.json`](./contracts/README.md),
  replayed from both sides by `test/replica-pact.test.ts`.
- **Tests:** `test/ephemeral-replica.test.ts` (the replica's rules, races on
  one backend, TTL, lost and expired logs on a minority, rejoin, and a seeded
  random run that never resolves two entries for one epoch);
  `test/routing.test.ts` and `test/policy.test.ts`. The PostgreSQL replica and
  shared assignment contract are exercised in `@hobo/data-postgres`.

## Architecture placement

A policy library, not a domain service. It handles no command and emits no
events, runs no actor, and keeps no event store, projection, materialized
view, snapshot or read store: a host (the relay's repair tick, the database
fleet's reconcile loop) reads the register, asks the policy, and logs the
decision; the register's log is the only state, and it lives on the members.
