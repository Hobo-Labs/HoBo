# `@hobo/backend-routing`

A fleet of interchangeable backends of which exactly one is active: which one
(the assignment register), and when to move (the budget policies). Nothing here
knows an engine. `@hobo/data-postgres` keeps its register in SQL tables on each
PostgreSQL backend; the hosted CI relay keeps it in one key of each cache
through `EphemeralStatePort` ([ADR-0179](../../docs/design/adr/hosted-relay-stateless.md#adr-0179),
phase 4c).

These parts lived in `@hobo/data-postgres` (`src/fleet/`) until phase 4c moved
them here, so a cache fleet can use them without depending on a PostgreSQL
package (which also keeps `@hobo/data-postgres` out of the relay's bundle for
phase 7). `@hobo/data-postgres` re-exports every moved name under the name it
always had (`PostgresFleetAssignment` is `FleetAssignment`, and so on); only
the error class changed, to `BackendFleetError`, with the same codes
(`FLEET_CONFIGURATION_INVALID`, `FLEET_RECORD_INVALID`) and messages.

It is a package of its own rather than part of `@hobo/core` because it is a
policy with its own records and pact, not a port: core holds the
`EphemeralStatePort` contract this package's cache replica is written
against, and nothing in core needs a fleet.

## What this package owns

| Concern | Entry point |
|---|---|
| Assignment entries and their identity | `parseFleetAssignment`, `assignmentKey`, `fleetMajority` |
| The register over any replica | `AssignmentReplica`, `resolveAssignment`, `readCurrentAssignment`, `proposeAssignment`, `bootstrapAssignment`, `completeAssignment`, `overrideAssignment` |
| The register on a cache | `ephemeralAssignmentReplica`, `ephemeralAssignmentRegister`, `rejoinAssignmentReplicas` |
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
empty: the member stops counting as a holder of anything. The register stays
safe while every decided entry is held by a majority, which the repair tick
ensures by copying the current entry onto every member that answers; losing
the log of any minority after that changes nothing a reader can conclude. A
log lost while it was part of a *bare* majority, before repair, with another
holder silent, leaves the register `undecided` (it fails closed), and
completion re-decides the same entry. `rejoinAssignmentReplicas` seeds an
emptied member with the current entry only when a majority of all members
other than itself hold it as their newest, which ordinary repair cannot do
once old epochs have been trimmed from every log.

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

## Gates

- **TypeScript:** `pnpm --filter @hobo/backend-routing run build`.
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
  `test/routing.test.ts`. The register's own cases still run in
  `@hobo/data-postgres` through its re-exports.

## Architecture placement

A policy library, not a domain service. It handles no command and emits no
events, runs no actor, and keeps no event store, projection, materialized
view, snapshot or read store: a host (the relay's repair tick, the database
fleet's reconcile loop) reads the register, asks the policy, and logs the
decision; the register's log is the only state, and it lives on the members.
