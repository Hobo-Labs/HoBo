# `@hobo/cd/rollout` — rollout orchestrator (WP10)

Progressive exposure for one promotion, Camp by Camp and stage by stage
(plan 0024: C3, C4, C5, D7, D8, D12). The promotion saga (WP6) calls
`plan` then `run`; the CD service (WP12) calls `tick` every
`CD_DEFAULTS.serviceTickMs`.

| File | Role |
|---|---|
| `orchestrator.ts` | `createRolloutOrchestrator`: plan, run, rollback, get, tick |
| `lowering.ts` | D7 lowering onto traffic rungs; stage percents from `CD_RAMP_DEFAULTS` |
| `routing.ts` | the neutral `stable`/`candidate` stage `RoutingPlan` |
| `journal.ts` | the `cd-rollout-<id>` ledger: bodies and the pure fold |
| `capacity.ts` | canary capacity through the shared hosting budget authority |
| `analysis.ts` | optional analysis-webhook `HealthSource` (status-gate and json-metric dialects) |
| `reasons.ts` | every typed failure with its remediation |
| `../adapters/harness.ts` | `RolloutEngine` over `OpenDeliveryEngine` (durable command ledger) |
| `../adapters/traffic.ts` | `TrafficShifter` over Station `executeRoutingCutover` |

## How a rollout runs

1. **Lowering (D7, I6).** For each target Camp the strategy is lowered onto
   the provider's declared traffic offerings, ranked `edge.canary` →
   `lb.weighted` → `dns.weighted` → `inprocess.weighted`. The rung and every
   rung skipped above it are recorded in `rollout.Lowered`. A canary,
   blue/green or experiment with no rung — or with a fallback forbidden by the
   `rollout.no-fallback` obligation — is refused with
   `progressive-unsupported`. Nothing is downgraded silently; an unspecified
   strategy lowers to canary.
2. **One ramp engine (D8).** `run` starts a staged `OpenDeliveryEngine`
   record: one stage per stage percent, the target Camps as ordered target
   groups (one Camp per group, `maxFailures` 0), `traffic: "flag-only"`, no
   auto-rollback. Ramps are `CD_RAMP_DEFAULTS` (canary `[5, 25, 50, 100]`,
   blue/green `[100]`, experiment `[50]` then `100`).
3. **Per Camp and stage**, each step recorded before its effect:
   capacity reservation (`hosting-budget`) → the reconciler must report the
   promoted Set `CONVERGED` → blue/green verifies the idle side → boundary
   checks (change windows, experiment conclusion, stage approval) → shift
   intent → Station cutover → observed split → verification → engine advance.
4. **Observation is authoritative (I5).** A provider acknowledgement is never
   convergence; the stage proceeds only when `TrafficShifter.status` reports
   the stage plan active and fully realized. A shift whose outcome is ambiguous
   is resolved by observation, never retried blindly.
5. **Fail closed.** FAIL, INCONCLUSIVE, a passed progress deadline
   (`VerificationSpec.progress_deadline_ms`, default
   `CD_DEFAULTS.verificationProgressDeadlineMs`), a rejected experiment, a
   denied approval or a refused capacity reservation rolls back.
6. **Rollback (D12, I7).** Zero exposure through Station cutover (the reverse
   cutover to the stable backend), then a rollback Delta (`intent: rollback`,
   base = the promoted Set, Freight = the predecessor Set's) opened on the
   Delta ledger for the promotion gate to decide and the reconciler to apply.
   The orchestrator never applies a Set (I2).

## Architecture notes

- **Commands, events, actors.** `plan`/`run`/`rollback`/`tick` are commands.
  Each decision appends an event to the rollout ledger on the durable event
  store with an expected-seq CAS, so one rollout behaves as a single-writer
  actor: two drivers can never both shift a Camp (I4, I12).
- **Event store, projections, snapshots.** The ledger is the whole truth.
  `foldRollout` is the projection (a materialized view of the rollout) that
  `get` reads; the engine adapter rebuilds its in-memory `OpenDeliveryEngine`
  snapshot from its own command ledger. No separate read store is needed:
  every read store view is a fold of the same streams, so replay equals live
  (I8; `test/rollout/golden-journal.test.ts`).
- **Parse, don't validate.** Ledger bodies are protobuf JSON of the generated
  records (`RolloutPlanRecord`, `ReasonRecord`, `ObligationRef`) decoded once
  at the fold into derived types (`RolloutLedgerState`); stage percents are
  parsed by `stagePercentsFor` into an `Outcome`, never re-checked downstream.
  `data-models/rollout.cue` constrains the same records and bodies, and
  `test/rollout/cue.test.ts` proves the two boundaries agree.
- **Streams.** `cd-rollout-<rolloutId>` (orchestrator ledger) and
  `cd-rollout-engine-<rolloutId>` (engine command ledger). Both ids are local
  to this module; the frozen `CD_STREAMS` has no rollout entry.
- **Event types.** Every ledger type is `rollout.<PastTenseFact>` beside the
  frozen `rollout.Lowered` / `rollout.EvidenceObserved`, so a durable journal
  (`@hobo/storage-sqlite`, `@hobo/storage-postgres`) accepts it:
  `rollout.RampStarted`, `CapacityReserved`, `ShiftRequested`, `Shifted`,
  `TrafficObserved`, `VerificationStarted`, `StageVerified`,
  `StageApprovalRequested`, `Held`, `Released`, `Advanced`, `RollbackStarted`,
  `RollbackDeltaOpened`, `Finished`, and `rollout.EngineCommanded` on the
  engine stream. (`rollout.Started` / `rollout.ApprovalRequested` belong to
  the OpenDelivery port in `@hobo/identity` with other bodies, hence
  `RampStarted` / `StageApprovalRequested`.) The ledger's first names
  (`cd.rollout.<Fact>`, refused by every durable journal) and the interim
  `cdrollout.<Fact>` storage encoding are upcast on read by `ledgerType`;
  bodies are unchanged. `test/rollout/golden/rollout-journal.legacy-cd-rollout.json`
  pins the legacy corpus, and `test/rollout/durable-journal.test.ts` runs
  plan, run and rollback on a real SQLite journal with the real desired state
  and reconcile transport.
- **PACT.** `test/rollout/pacts/analysis-webhook.pact.json` (verified by
  `test/rollout/analysis.test.ts`). The Station cutover boundary is exercised
  against the real `executeRoutingCutover` in `test/rollout/traffic.test.ts`.

## Metrics (TelemetrySink)

| Metric | Kind | Attributes |
|---|---|---|
| `hobo.cd.rollout.lowered` | counter | rollout, Camp, strategy, offering, fallback, refusal code |
| `hobo.cd.rollout.shifts` | counter | Camp, percent, realized |
| `hobo.cd.rollout.stages` | counter | Camp, percent |
| `hobo.cd.rollout.held` | counter | reason code |
| `hobo.cd.rollout.rollbacks` | counter | reason code |
| `hobo.cd.rollout.completed` | counter | status |
| `hobo.cd.rollout.duration` | histogram (ms) | status |
| `hobo.cd.rollout.tick_errors` | counter | rollout |

## Runbook

**A rollout is stuck in `running`.** Read the ledger
(`cd-rollout-<id>`). The last event names the step:
`ShiftRequested` without `Shifted` means the cutover call is in flight or
died — the next tick observes the plan's status, it never re-shifts.
`Shifted` without `TrafficObserved` means the provider acknowledged but the
split is not observed (`rollout-traffic-unconverged` at the deadline): check
the Station routing state for the plan id. `VerificationStarted` without
`StageVerified` means the verification engine has no verdict yet; after twice
the progress deadline the rollout fails closed.

**`awaiting-window`.** A change window is closed for a target Camp. The
rollout resumes on the first tick after it opens. To proceed early, record a
governed override (`window.override`, ≤ 4 h). A rollback held by
`rollout-rollback-window-closed` means a freeze forbids rollback: override it
if the rollback must run now.

**`awaiting-approval`.** The plan carries the `rollout.stage-approval`
obligation; approve the request named in the reason's subject through the
approval port. Denied or expired approvals roll back.

**`progressive-unsupported`.** No declared traffic offering realizes the
strategy on a Camp. Add a traffic profile for the provider, or promote with
`ROLLOUT_STRATEGY_ALL_AT_ONCE` explicitly. Re-planning with new offerings gets
a new rollout id.

**`failed` with `rollback-non-convergeable`.** Zero exposure was not observed
before the deadline (needs-human). Restore routing at the Station to the
stable backend, confirm `TrafficRoutingPort.status`, then close the incident;
the ledger is terminal and no further work is emitted.

**`rolled-back` with `rollback-delta-opened`.** The rollback Delta named in
the reason subject is open; the promotion gate decides it and the reconciler
applies the predecessor Set. `rollback-no-predecessor` names Camps with no
previous Set: tear them down with intent `down` if needed.

**Capacity refusals.** `canary-capacity-unavailable` comes from the hosting
budget authority; `canary-capacity-unconfigured` means the gate attached a
`hosting-budget` obligation but no capacity port is composed (WP18).
