# `@hobo/fleet/assignment`

The one-active assignment register (design §6.10), moved from
`@hobo/backend-routing` (`assignment.ts`, `ephemeral-replica.ts`, `backend.ts`)
with the names of §7.3: `AssignmentEntry`, `AssignmentValue`, `MemberName`,
`Health`, `FailureClassifier`. The algorithm is unchanged: every member keeps
an append-only log, an epoch is decided by a majority of its deciding set, and
readers fail closed (`no-majority`, `undecided`).

| File | What it holds |
|---|---|
| `register.ts` | Entry parsing, `assignmentKey`, `fleetMajority`, `resolveAssignment`, propose, bootstrap, complete, override, `proposeMembership`, `decidingSet` |
| `log.ts` | `encodeAssignmentLog` / `decodeAssignmentLog`: format 1 (today's bytes) and format 2 (member sets) |
| `replica.ts` | The cache-key replica over `EphemeralStatePort` (stored key `hobo:fleet:assignment`, unchanged), its register, `rejoinAssignmentReplicas` |
| `one-active.ts` | `createOneActiveFleet`: the cache fleet's tick over injected ports |

**Membership epochs.** Off by default (`FleetPolicy.membership_epochs`). While
off, nothing writes `members`, logs stay format 1 and the previous relay reads
them. Once on, the first tick pins the configured set (`pin-members`), and later
ticks admit or remove one name per decided epoch (`admit:<name>`,
`remove:<name>`), never the active member, a sealed fleet's target or the last
member, and never while sealed. The set that decides epoch `e` is read from
entry `e` (`decidingSet`), never from configuration.

**Operations.** A fleet sealed longer than twice `sealWaitMs` logs
`hobo_fleet_assignment_sealed_too_long` on every tick (F24); every tick logs
`hobo_fleet_assignment_tick`. While the pin is being decided, every instance of
the fleet must run one configuration.

**Interim.** `createOneActiveFleet` computes member eligibility with a private
copy of the §6.8 rules until `eligibleForActive` (L03, wave 2) lands; it should
then call that entry point instead.
