# `@hobo/cd/fanout` — fan-out over a placement decision (WP23)

Implements `createFanoutController` (frozen `FanoutController` port) for
plan 0024 D21 and invariant I20. A placed pipeline node does not list Camps;
it names a Placement. The pipeline controller records a
`PlacementDecisionRecord` and starts a fan-out over it. The fan-out only
**schedules ordinary per-Camp promotions**. Gate, windows, verification and
lineage still apply per Camp, unchanged.

## Model

| Concept | Where |
|---|---|
| Plan (limits resolved to counts) | `policy.ts` `parseFanoutPlan` |
| Scheduler (pure) | `schedule.ts` `schedule`, `budgetExceeded` |
| Per-Camp outcome rules (pure) | `classify.ts` `classify`, `eligibility` |
| Event bodies | `facts.ts` (protobuf JSON of cd.proto records) |
| Projection (fold) | `state.ts` `fold`, `statusOf` |
| Saga + commands | `controller.ts` `createFanoutController` |
| Data-resource classifier | `data.ts` `dataResourcesOf` (shared with failover) |
| Journal plumbing | `journal.ts` (CAS append, leases, codecs, metrics) |

**Parse, don't validate.** `parseFanoutPlan` turns the wire `FanoutRecord`
and `PlacementDecisionRecord` into the derived type `FanoutPlan`. Every
percent is resolved to a count against the decision size. Mandatory groups are
checked against the decision, a Camp may sit in only one group, and the run
order puts mandatory groups first. Nothing downstream re-reads the wire
records. The parsed types are the only inputs the scheduler accepts, and the
CUE constraints in `data-models/fanout.cue` agree with this boundary
(`test/fanout/cue.test.ts`).

**Event architecture.**

- *Commands*: `start`, `halt`, `resume` and `rollback` are authorized
  (`promote`, `fanout.halt`, `fanout.resume`, `fanout.rollback`;
  proposal-only principals are refused). `tick` is the saga driver.
- *Events*: `fanout.Started`, `fanout.Progressed` (one per Camp transition),
  `fanout.Halted`, `fanout.Resumed`, `fanout.Completed` (COMPLETED or
  SUPERSEDED), `fanout.RolledBack` and `camp.Departed`. They live on
  `cd-fanout-<id>` in the durable event store.
- *Actor*: one controller per fan-out holds lease `cd:fanout:<id>`. That is
  a durable subscription lease on SQLite or Postgres, and a process-local
  lock on a store without leases. Each append is a stream-head CAS at the
  folded revision.
- *Projection and read store*: the stream's fold (`state.ts`) is the
  materialized view. `get`, `list` and `qualified` read it. Replay equals
  live (I8), and a test folds the journal and compares it with the live
  status. No snapshot is taken: a fan-out stream is bounded by
  ~4 events per Camp. A snapshot can be added under the same fold if a
  fleet outgrows that.

## Behaviour

- **Strategies.**
  - `ALL`: every Camp at once, capped by an explicit `max_concurrency`.
  - `PROGRESSIVE`: rolling over the run order.
  - `PROGRESSIVE_PER_GROUP` (default): one group at a time.
  - In every strategy, mandatory groups run first and must all succeed.
- **Concurrency (I20).** Never more than `max_concurrency` Camps are in
  flight. The default is the decision's largest group (I.9: "concurrency =
  group size"). Transitions are journaled **before** their side effect
  (write-ahead). The promotion request follows, with idempotency key
  `fanout:<id>:<camp>`, so crashes, retries and competing replicas cannot
  exceed the bound. A chaos test shows this.
- **Outcomes** (D21):
  - *succeeded*: `freight.Qualified` for the Camp plus `min_success_ms`.
  - *failed*: the promotion is REJECTED, FAILED or ROLLED_BACK, or
    `progress_deadline_ms` elapsed.
  - *deferred*: at the Camp's turn it has a NO_PLACE/NO_RUN taint, is not
    REACHABLE, has no inventory status, is not MANAGED, or a window is
    closed. A promotion superseded by newer Freight also defers. Deferred
    Camps never count against `max_failures`.
- **Halt.** The run halts when failures since the last resume exceed
  `max_failures` (count, or percent of the decision), when a mandatory Camp
  fails, or when the Freight is yanked (I13). With `rollback_on_halt`, only
  the failed Camps roll back (D12), through the gate.
- **Supersede.** A fan-out of newer Freight on the same node marks older
  active fan-outs. They stop at their next group boundary (no Camp in flight),
  and the newer one waits until then.
- **Late entry.** After completion, deferred Camps that recover catch up to
  the node's qualified Freight (`AUTO_PROMOTION_MATCH_NODE` semantics). A
  Camp that already carries or is moving to another promotion is left alone
  that tick.
- **Departure.** Camps the new decision drops get a `depart` promotion
  (intent `depart`) once the new fan-out completes. `camp.Departed` records
  the `DepartureAction` and what was kept: data resources for `ORPHAN_DATA`
  (the default), everything for `ORPHAN`, nothing for `DELETE`.
- **Failover substitution.** `qualified` returns the effective decision. Each
  completed failover replaces its source Camp with the replacement.

## Metrics (`TelemetrySink`)

| Name | Kind | Attributes |
|---|---|---|
| `hobo.cd.fanout.started` | counter | pipeline, node, strategy |
| `hobo.cd.fanout.transitions` | counter | pipeline, node, outcome |
| `hobo.cd.fanout.in_flight` | gauge | pipeline, node |
| `hobo.cd.fanout.halted` | counter | pipeline, node, reason |
| `hobo.cd.fanout.completed` | counter | pipeline, node, state |
| `hobo.cd.fanout.rolled_back` | counter | pipeline, node |
| `hobo.cd.fanout.departed` | counter | pipeline, node, action, outcome |
| `hobo.cd.fanout.refused` | counter | pipeline, node, reason |
| `hobo.cd.fanout.step_errors` | counter | pipeline, node, step |
| `hobo.cd.fanout.waiting` | counter | pipeline, node, reason |

## Typed failures

| Code | Meaning | Remediation |
|---|---|---|
| `fanout-invalid` | ambiguous or out-of-range limits | set a count or a percent, ≤ 100 |
| `fanout-decision-mismatch` | decision is for another node | start with this node's decision |
| `fanout-mandatory-group-unknown` | mandatory group not in decision | name a declared group |
| `fanout-duplicate-camp` / `fanout-empty-decision` | malformed decision | re-decide the placement |
| `fanout-freight-unusable` | yanked or retired Freight (I13) | promote newer Freight |
| `fanout-failure-budget-exceeded` | halt: too many failures | fix the cause, resume or roll back |
| `fanout-mandatory-group-failed` | halt: a mandatory Camp failed | fix, roll back or promote newer Freight |
| `fanout-progress-deadline` | a Camp did not qualify in time | inspect its promotion and verification |
| `fanout-superseded` | newer Freight took over | none |
| `camp-tainted`, `camp-unreachable`, `camp-status-unknown`, `camp-not-managed`, `window-closed` | deferral reasons | the Camp catches up when the cause clears |
| `fanout-rollback-refused`, `fanout-departure-refused` | the gate refused a compensating Delta | follow the named remediation |
| `proposal-only` | principal may only propose | have an operator run it |

## Runbook

- **A fan-out is HALTED.** Run `hobo deploy fanout get <id>`. `reasons[0]`
  names the cause and `failed` lists the Camps. With `rollback_on_halt`, those
  Camps already have rollback promotions (`fanout:<id>:<camp>:rollback`). Fix
  the cause, then either `fanout resume <id>` (the budget restarts from the
  failures already counted) or `fanout rollback <id>`. A mandatory-group
  failure cannot be resumed past: roll back, or promote newer Freight.
- **Camps stay deferred.** Check `hobo deploy camp status <camp>`. A taint,
  `REACHABLE=false` or a closed window explains it. Deferred Camps catch up on
  their own once the cause clears. They never burn the failure budget.
- **Nothing moves.** `hobo.cd.fanout.in_flight` is flat and the stream does
  not grow. Another replica may hold `cd:fanout:<id>`; check the lease
  holder. Or an older fan-out of the node is still active and waiting for its
  group boundary (`hobo.cd.fanout.waiting` with reason `fanout-awaiting-supersede`).
- **`step_errors` rising.** A port (promotion service, inventory, windows) is
  failing transiently. Nothing is decided on an error. The next tick retries
  idempotently.
- **Departure kept data.** That is the `ORPHAN_DATA` default. `camp.Departed`
  lists the kept resources. Remove them deliberately, with a `DELETE` node
  departure or by hand.
