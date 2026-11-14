# Contracts

## `one-active-choose-action.pact.json` — the one-active loop's `chooseAction`

`createOneActiveFleet` (`@hobo/fleet/assignment`) is the **consumer**: on each
tick it hands its `chooseAction` the current assignment and one
`NamedObservation` per member, and expects one action back. This package is
the **provider**: `routeFleetByBudget` answers a loss-tolerant fleet (the
relay's cache fleet), `decideFleet` a database fleet (`@hobo/data-postgres`).

Each interaction is one question: the request path names the function, the
body the active member, the configured members and their observations (health
as the `hobo.fleet.v1.Health` value name); the response is the action, its
target and loss window, its reasons and, where pinned, a standby's reasons.
Two details are load-bearing: a member's health and its reasons come from
`eligibleForActive`, so the reason strings are `@hobo/fleet`'s; and a database
standby that is not `ready` is reported as `schema-not-current`.

`test/choose-action-pact.test.ts` replays every interaction against the
functions themselves.

## Moved away

The cache replica's pact (`ephemeral-assignment-replica.pact.json`) moved with
the assignment register to `packages/fleet/contracts/`, and the SQL replica's
statements are pinned where it lives, in `@hobo/data-postgres`.
