# `@hobo/cd/failover` — governed failover and rebalance (WP23)

Implements `createFailoverController` (frozen `FailoverController` port) for
ADR-0182 D23 and invariant I21. A failover is a saga that moves
**compute only**. It runs only when the Rail allows it (`automatic`) or an
authorized principal approves it, within the Rail's per-Station
`max_concurrent` budget. It never fails back automatically.

## Model

| Concept | Where |
|---|---|
| Rail permission, node purge policy, NO_RUN toleration, `failover-unsafe` (pure) | `policy.ts` |
| Saga, commands and rebalance | `controller.ts` |
| Event bodies (`FailoverFact`) | `../fanout/facts.ts` (shared with the fan-out's effective-decision view) |
| Data-resource classifier | `../fanout/data.ts` |

**Parse, don't validate.** `railFailover` and `nodeFailover` turn the
optional wire records (`RailFailoverRecord`, `FailoverPolicyRecord`) into
derived types with every default applied (R13: automatic off,
`max_concurrent` 1, GRACEFUL, 30-minute grace). `noRunDue` and
`failoverUnsafe` are pure over parsed inputs. Event bodies are parsed by
`parseFailoverFact`, and an unparseable body is skipped, never guessed. The
CUE constraints in `data-models/failover.cue` agree with the recorded bodies
(`test/failover/cue.test.ts`).

**Event architecture.**

- *Commands*: `propose` (`failover.propose`), `approve` (`failover.approve`)
  and `rebalance` (`rebalance`). Each is authorized, and proposal-only
  principals are refused. `tick` proposes for untolerated NO_RUN taints and
  drives every open saga.
- *Events* on `cd-failover-<id>`: `failover.Proposed`, `failover.Started`,
  `failover.Progressed`, `failover.Completed` and `failover.Refused`.
  ABANDONED is a `Progressed` body with that state. `rebalance.Requested` is
  on `cd-failover-rebalance-<id>`. Every body carries the full
  `FailoverRecord`, so the fold is "last record wins".
- *Actor*: lease `cd:failover:<id>` per saga. Admission takes a second lease
  scoped to the Station (`cd:failover:station-<id>`), or to the rebalance for
  moves. That keeps `max_concurrent` across replicas. Appends are stream-head
  CAS in the durable event store.
- *Projection and read store*: the fold of each stream is the materialized
  view that `get` and `list` read. No snapshot is needed: a failover stream
  holds about ten events.

## Saga

```
PROPOSED ──(Rail automatic | approval; Station budget)──▶ REPLACING ─▶ VERIFYING ─▶ SHIFTING ─▶ PURGING ─▶ COMPLETED
    └─▶ REFUSED (never started: unsafe, no Freight, no replacement, residency, handover, gate)
REPLACING/VERIFYING/SHIFTING ─▶ ABANDONED (replacement failed, or grace expired: both Camps kept)
```

1. **Admission checks.** The source must hold no data resources: none in its
   resolved plan, and none the reconciler observed with a classification or a
   data kind. Otherwise the saga is refused `failover-unsafe`, naming a
   Trails replica handover. The node must have qualified Freight. Declared
   `handover_outputs` must be present in the source's last observation.
2. **Replacement.** Placement re-decides one Camp. Tainted Camps, the source
   and current members are excluded. Spread, residency and bindings are
   honoured. The controller then re-checks residency on the replacement's
   **declared** regions with `evaluateResidency` (defense in depth). With a
   `junctions` port, unreachable data is `failover-unsafe`.
3. **Promote** the node's qualified Freight to the replacement with intent
   `failover` and `sourceCampId`. The handover outputs are recorded on the
   failover record.
4. **Verify.** The replacement's promotion must reach PROMOTED (verification
   PASS). FAILED, REJECTED, ROLLED_BACK or SUPERSEDED gives ABANDONED, and the
   source is kept.
5. **Shift traffic** only through the `TrafficShifter` (Station cutover), with
   a plan that sends 100% to the replacement. The saga holds until the shift
   is realized `full` and active.
6. **Purge** the source per `PurgeMode`, as a `depart` promotion:
   - GRACEFUL: only after steps 4–5, so the replacement has already qualified.
   - NEVER: no purge.
   - IMMEDIATE: right after admission, and only when the Rail sets
     `allow_immediate_purge`. Otherwise it is recorded and downgraded to
     GRACEFUL.
7. If a phase outlives `grace_ms`, the saga is ABANDONED and both Camps are
   kept. That is the escalation.

**No automatic failback.** A taint that clears changes nothing. Moving work
back is an explicit, authorized `rebalance`. Rebalance re-decides the
placement, records `RebalanceRecord.moves` (leaving Camps paired with
entering Camps, in id order), and runs each move through the same saga as
GRACEFUL. At most the node's fan-out `max_concurrency` moves run at once.

## Metrics (`TelemetrySink`)

| Name | Kind | Attributes |
|---|---|---|
| `hobo.cd.failover.proposed` | counter | pipeline, node, trigger |
| `hobo.cd.failover.started` | counter | pipeline, node, purge |
| `hobo.cd.failover.transitions` | counter | pipeline, node, state |
| `hobo.cd.failover.completed` / `.refused` / `.abandoned` | counter | pipeline, node, reason |
| `hobo.cd.failover.active` | gauge | tenant |
| `hobo.cd.rebalance.requested` | counter | pipeline, node |
| `hobo.cd.failover.step_errors` | counter | failover |

## Typed failures

| Code | Meaning | Remediation |
|---|---|---|
| `failover-unsafe` | data in the source, or unreachable from the replacement | Trails replica handover first; data never moves |
| `failover-not-tainted` | `propose` without a NO_RUN taint | taint NO_RUN, or use `rebalance` |
| `failover-no-qualified-freight` | node has no completed fan-out | complete a fan-out first |
| `failover-handover-missing` | declared output not observed | have the reconciler report it |
| `placement-context-missing` | no Station/residency context composed | wire `placementContext` (fail closed) |
| `failover-no-replacement` / `placement-unsatisfiable` | nothing eligible | bind more Camp sets or relax spread |
| `failover-residency-failed` | replacement region fails residency | fix the placement's residency |
| `failover-replacement-failed` | replacement promotion failed | inspect the replacement; propose again later |
| `failover-grace-expired` | phase outlived `grace_ms` | escalate; both Camps are kept |
| `failover-immediate-purge-not-permitted` | IMMEDIATE without Rail permission | set `allow_immediate_purge` |
| `failover-purge-refused` | the gate refused the depart | purge with an approved depart |
| `proposal-only` | principal may only propose | have an operator run it |

## Runbook

- **A region is down and nothing fails over.** Check the Camp's taints. Agents
  can never add NO_RUN, and the taint needs ≥ 2 signals, one of them
  Station-observed (WP22). Then check the node's tolerations: `toleration_ms`
  0 tolerates forever. Then check Rail `delivery.failover.automatic`. When it
  is off, `hobo deploy failover list --state PROPOSED` shows the proposal;
  approve it with `failover approve <id>`.
- **Only one failover runs at a time.** That is `max_concurrent` (default 1)
  per Station. The others stay PROPOSED and are admitted in proposal order.
- **REFUSED `failover-unsafe`.** The Bindle's database (or another data
  resource) lives in the failing Camp. Run a Trails replica handover (expand
  a replica reachable from the target, cut over, contract), then propose
  again with a new idempotency key.
- **ABANDONED.** The replacement failed or the grace expired. Both Camps are
  intact and the source was never purged. Inspect the replacement promotion
  named on the record before retrying.
- **The old Camp recovered.** Nothing happens automatically, by design. To
  move work back, run `hobo deploy rebalance <pipeline> <node>` (authorized).
  Moves run GRACEFUL under the node's fan-out limit.
