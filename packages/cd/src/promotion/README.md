# `@hobo/cd/promotion` — promotion saga, gate, previews, Trails

Work package WP6 of [plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md)
(C9, D2, D11, D12, I7, I13, I16; fleet and policy D20–D25).
`createPromotionService` implements the frozen `PromotionService &
PreviewEnvironments` ports (`src/ports.ts`). Promote means: carry the same
Freight, re-run Matching per target Camp, and apply the result as a Delta
through the gate. Bytes never change (I1); infrastructure may, and the
difference against the source Camp is the Delta's `infrastructure_diff`.

## The saga

One saga per promotion, defined with `@hobo/events` `defineSaga`, journaled on
`cd-promotion-<id>`. The forward path advances every target Camp as far as the
journal and the ports allow; the compensation path runs ON_FAILURE hooks and
rolls the environment group back. `tick` resumes any promotion from its
journal, so a crash anywhere resumes by re-reading facts.

| # | Step (per Camp) | Port | Recorded as |
|---|---|---|---|
| 1 | authorize (`promote`, `rail.promote`, `preview.create`) | `CdAuthorizer` | refusal, or `proposal=true` for proposal-only principals |
| 2 | refuse yanked/retired Freight (I13; checked again every step) | `FreightLedger.isUsable` | refusal / `env.PromoteRejected` |
| 3 | lineage (I16) unless an unexpired `freight.Approved` covers the target | `PipelineController.available` | `lineage-unsatisfied` / `shadow-required` |
| — | fan-out aggregate (D20) when `fanoutId` is set, before any Camp starts | `FanoutAggregateGate` | `fanout-budget-exceeded` |
| 4 | per-Camp queue: newest queued wins; a Camp past apply holds the queue | journal | `env.PromoteSuperseded` (older), open Delta rejected |
| 5–6 | resolve + open the Delta (`changes`, `infrastructure_diff`) | `SetResolver`, `DeltaLedger.open` | step `resolved` (Delta id) |
| 7 | gate: policy, compat, trust, residency, ownership conflicts, windows, shadow | `DeployGate` | step `gated` (`<effect> <decisionId>`), or `awaiting-window` |
| 8 | approval: proposals, `require-approval`, `approval_required` | `ApprovalPort`, `approve()` | steps `approval-requested`, `approved` |
| 9 | BEFORE_APPLY hooks | `HookRunner` | step `before-apply` |
| 10 | Trails `expand` when the Freight changes data shape | `TrailsMigrations` | step `expanded` (migration id) |
| 11 | apply: Set (sealed with the gate decision) or, for `RAIL`, `CampPolicy.bind` | `DeltaLedger.apply` / `CampPolicy` | step `applied` (Set id / binding) |
| 12 | progressive rollout (workloads only) | `RolloutOrchestrator` | steps `rollout`, `converged` |
| 13 | AFTER_CONVERGED hooks | `HookRunner` | step `after-converged` |
| 14 | verification; only PASS qualifies (I5) | `VerificationEngine` | step `verification` |
| 15 | `freight.Qualified` → AFTER_QUALIFIED hooks → `env.Promoted` | `FreightLedger.qualify` | steps `qualified`, `after-qualified`; `env.Promoted` |
| 16 | Trails `contract` after `required_soak_ms` | `TrailsMigrations` | step `contracted` |

A port that throws is transient: nothing is decided, the step is retried on
the next tick, and `hobo.cd.promotion.step_error` counts it. A typed refusal
from a port fails the Camp. A failure before apply rejects; after apply it
fails and compensates (zero exposure through `RolloutOrchestrator.rollback`,
then a Delta to the predecessor Set through the same gate — D12, I7). In a
multi-Camp promotion (an environment group) every applied member is rolled
back and every other member is marked compensated.

### Rollback

`rollback({ campId })` zeroes exposure of any in-flight rollout, then opens a
`rollback` Delta to the predecessor Set (or `toSetId`), gates it (rollback is
allowed in windows unless a freeze forbids it), and applies it with origin
`SET_ORIGIN_ROLLBACK`; `env.PromoteRolledBack` records it on its own promotion
stream. It is refused past a completed Trails `contract`, naming the
compensating `expand`. For a Camp whose latest promotion was a Rail, rollback
calls `CampPolicy.restore` (the previous enforced digest).

### Previews

`createPreview` mints an ephemeral Camp `<source>--pv-<hash>` (planned and
gated with its source Camp's topology, labelled `hobo.cd/preview=true`),
records `env.Cloned` and promotes with intent `preview`. `expirePreviews`
applies a teardown Delta (intent `down`, `SET_ORIGIN_TEARDOWN`) through the
gate once the TTL passes and records `env.Expired`.

### Intents and subjects

`PromoteRequest.intent` selects the Delta intent and the Set origin: `promote`,
`config`, `topology`, `failover`, `depart`, `posture-remediate`, `up`,
`down`, `preview`, `drift-remediate`. Freight with subject `RAIL` writes the
binding (`INFORM` candidate or `ENFORCE`) through `CampPolicy.bind` instead of
a Set, and moves no traffic.

## Journal schema (`cd-promotion-<id>`)

| Event | Body |
|---|---|
| `env.PromoteRequested` | `PromotionRecord` (state `QUEUED`) |
| `saga.Started` | `@hobo/events` saga fact; `name` = `cd.promotion/<intent>` |
| `saga.StepEmitted` | `step` = `<campId>\|<step>`, `emittedType` = the step's handle |
| `env.Promoted` / `env.PromoteRejected` / `env.PromoteSuperseded` | `PromotionRecord` with `targetCampIds = [campId]` |
| `env.PromoteRolledBack` | `PromotionRecord` (state `ROLLED_BACK`) |
| `env.Cloned` / `env.Expired` | `PreviewEnvironmentRecord` |
| `saga.Compensated`, `saga.Completed` | `@hobo/events` saga facts |

Approval requests and decisions (from `approve()`, the A2H approver or the
webhook callback) are `saga.StepEmitted` facts on the same stream, scoped
`<campId>` or `<campId>/<stage>`. Ids are deterministic digests of the tenant
and idempotency key (`promo_`, `rollback_`, `preview_`), so a repeated command
returns the recorded promotion (I12) and a key reused for other Freight or
targets is refused. CUE constraints: [`data-models/promotion.cue`](../../data-models/promotion.cue).

## Adapters (`src/adapters/`)

| File | Implements | Notes |
|---|---|---|
| `planning.ts` | `SetResolver` | `@hobo/cloud` `plan(declaration, config, registry)` — the `pureplan` path. Verifies the declaration digest equals the Freight's `declaration_hash` (fail closed). `down` = empty plan; `depart` keeps data ports (ORPHAN_DATA). `diffResolvedSets` is the rule `DeltaLedger.apply` checks. |
| `gatekeeper.ts` | `DeployGate`, `FanoutAggregateGate` | `evaluateGatekeeper` with the Camp's enforced Rail pack (binding, else Station Rail, else permissive default); can-deploy fails closed on unknown running versions; unverified provenance and stale trust evidence deny; residency over declared Yard regions; ownership conflicts (I22); windows passed through; candidate Rail evaluated in shadow and recorded through `ShadowRecorder` (D24). |
| `approval.ts` | `ApprovalPort` | A2H handoff (NotificationPort) decided by an authorized human; CloudEvents webhook approver with an HMAC-SHA256 signed callback. Subjects `promotion:<id>/<scope>`. |
| `trails.ts` | `TrailsMigrations` | Bound to `@hobo/trails` `executeDataMigration` by composition; label `hobo.cd/data-migration`. |
| `hooks.ts` | `HookRunner`, `NotificationPort` | RUNBOOK → `RunbookExecutor` (`createRunbookExecutor` in `@hobo/hobo`), SUITE → `VerifyPort`, NOTIFY → CloudEvents structured mode. NOTIFY is best-effort. |

## Contracts and proofs

- PACT: [`test/promotion/promotion.pact.json`](../../test/promotion/promotion.pact.json)
  (pipelines, fan-out and operators → promotion; webhook approver; NOTIFY),
  verified by `promotion.pact.test.ts`.
- Protobuf: `PromotionRecord`, `PreviewEnvironmentRecord`, `ObligationRef`,
  `PromotionState` in `data-models/cd.proto` (frozen); CUE in
  `data-models/promotion.cue`, vetted against real bodies by `cue.test.ts`.
- Promoted proofs: `can-deploy-compatibility-gate-contract` (`gate.test.ts`,
  "can-deploy (promoted proof)") and `champion-challenger-promotion-contract`
  (`promoted-proofs.test.ts`).

## Metrics (`TelemetrySink`)

| Metric | Kind | Attributes |
|---|---|---|
| `hobo.cd.promotion.requested` / `refused` | counter | intent, subject, proposal / reason |
| `hobo.cd.promotion.step` / `step_error` | counter | step, camp / error |
| `hobo.cd.promotion.promoted` / `failed` / `superseded` / `compensated` / `rolled_back` | counter | camp, reason |
| `hobo.cd.promotion.lead_time` | histogram (ms) | camp |
| `hobo.cd.preview.created` / `expired` | counter | source |
| `hobo.cd.gate.decided` / `shadow_diverged` | counter | camp, intent, effect, window |
| `hobo.cd.hook.run` | counter | kind, point, outcome |
| `hobo.cd.approval.requested` / `decided` | counter | approver, outcome |

A failing sink never fails a command.

## Runbook

| Symptom (reason code) | Meaning | Action |
|---|---|---|
| `lineage-unsatisfied` | The Freight is not available to the node (not qualified upstream or not soaked). | Promote it through the upstream node, wait for `required_soak_ms`, or record an expiring `freight.Approved` hotfix for the Camp (`FreightLedger.approve`, governed `freight.approve`). |
| `shadow-required` | A Rail is promoted to ENFORCE without a qualified INFORM node upstream. | Bind it in INFORM first and let posture verification qualify it. |
| `promotion-superseded` | Newer Freight was queued for the Camp before this one applied. | Nothing; the newest proceeds. |
| State `AWAITING_WINDOW` (`window-closed`) | A freeze is active; nothing applies (I17). | Wait for the window, or record a governed `window.Overridden`. |
| State `AWAITING_APPROVAL` | A proposal, a `require-approval` gate effect, or `approval_required`. | Approve through `PromotionService.approve` (the `deploy` verb surfaces it; a human or granted principal), answer the A2H handoff, or the webhook approver's callback. Unanswered requests expire after 24 h. |
| `promotion-gate-denied` | The gate denied; the following reasons name the gate (`policy`, `contracts`, `residency`, `trust`, `posture`). | Fix each named cause; for `unknown-running-versions` rebuild the Camp's running-contract snapshot. |
| `ownership-conflict` | A posture rule contradicts a Set-owned value and the Delta keeps it. | Change the declaration of the named resource, or retire the rule. |
| `fanout-budget-exceeded` | The fan-out's Camp count or summed cost quotes exceed the Rail/entitlement/Station budget. | Narrow the placement or raise the budget; nothing started. |
| `promotion-verification-failed` | Verification ended FAIL or INCONCLUSIVE; the Camp was rolled back. | Inspect the verification checks named in the promotion's reasons; promote fixed Freight. |
| `rollback-past-contract` | Trails already contracted the old data shape. | Run the compensating Trails `expand` named in the remediation, then roll back. |
| `rollback-no-predecessor` | The Camp has no earlier Set. | Exposure was zeroed; promote known-good Freight or tear down with `hobo down`. |
| `promotion-trails-unavailable` | The Freight names a migration but no Trails sequencer is composed. | Compose `createTrailsMigrations` (WP18 does this in `hobo serve cd`). |
| `promotion-delta-refused` / `delta-overlap` | Another Delta is open for the Camp. | Find it with `DesiredStateReader`; a promotion that died mid-flight is resumed by `tick`; reject an abandoned Delta. |
| `hobo.cd.promotion.step_error` rising | A port is throwing (transient). | Check the named dependency (orchestrator, verification, approval endpoint); promotions resume on recovery. |
| `approval-signature-invalid` (401 on the callback) | The callback token was not signed with the configured secret. | Check the approver uses the token it received; rotate the secret ref if leaked (old tokens then fail closed). |
| `preview-teardown-refused` | The gate refused a preview's teardown. | Fix the gate causes; `expirePreviews` retries each sweep. |
