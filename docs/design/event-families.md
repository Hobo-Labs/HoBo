---
type: Reference
title: "HoBo Event Families"
description: "This catalog is the canonical event-family inventory for design docs. Add a family here before using a new backticked event name elsewhere."
tags: [hobo, design]
---

# HoBo Event Families

This catalog is the canonical event-family inventory for design docs. Add a family here before using a new backticked event name elsewhere.

| Family | Example events |
|---|---|
| `actor.*` | `actor.Activated`, `actor.StateAppended` |
| `agent.*` | `agent.GuardrailBlocked`, `agent.GuardrailCleared`, `agent.DestroyDenied` |
| `aggregate.*` | `aggregate.PastTenseFact` |
| `access.*` | `access.MembershipAssigned`, `access.MembershipRevoked`, `access.CrossEnvGranted`, `access.CrossEnvExpired`, `access.ElevatedMinted`, `access.ElevatedDenied`, `access.BreakGlassRequested`, `access.BreakGlassGranted`, `access.BreakGlassExpired`, `access.BreakGlassReviewed`, `access.OverlayJoinDenied`, `access.PolicyPackActivated` |
| `alert.*` | `alert.Fired`, `alert.Grouped`, `alert.Routed`, `alert.Silenced`, `alert.Inhibited`, `alert.Deduped`, `alert.InhibitionCycleRejected`, `alert.Resolved` |
| `authmd.*` | `authmd.AgentRegistered`, `authmd.ClaimInitiated`, `authmd.PrincipalClaimed`, `authmd.ScopeWideningDenied`, `authmd.CredentialsRotated`, `authmd.PrincipalRevoked` — agent identity events in `packages/auth-md/src/events.ts`, composed through the CLI agent identity flow |
| `bindle.*` | `bindle.ResourcesCollected`, `bindle.ManifestProduced` |
| `binding.*` | `binding.Resolved` (plan-phase profile→product+connectivity selection per edge), `binding.Projected` (deploy-time workload wiring; **not** per-activation client construction), `binding.Unavailable` (fail-closed refusal with remediation). Yard binding **rows** are carried on `yard.Registered` rather than a separate declaration event, so row state is never duplicated; rotation/revocation facts stay on the claim coordinator (`@hobo/claims`) ([ADR-0157](./adr/07-portability-extensibility.md#adr-0157)) |
| `breakglass.*` | `breakglass.Requested`, `breakglass.Approved`, `breakglass.Started`, `breakglass.Used`, `breakglass.Revoked` |
| `broker.*` | `broker.Requested`, `broker.Resolved`, `broker.Rejected`, `broker.ScaleRequested`, `broker.DeliverySubmitted`, `broker.ResolutionSigned`, `broker.EnvironmentPublished`, `broker.EnvironmentApproved` |
| `build.*` | `build.Started`, `build.ArtifactProduced`, `build.Completed`, `build.Failed` — CLI build events in `packages/cli/src/build/events.ts` |
| `camp.*` | `camp.Created`, `camp.RuntimeBound` |
| `budget.*` | `budget.ThresholdCrossed`, `budget.Recovered`, `budget.CreditApplied` |
| `capability.*` | `capability.Denied`, `capability.GrantDenied` |
| `chaos.*` | `chaos.ExperimentStarted`, `chaos.FaultInjected`, `chaos.FaultRemoved`, `chaos.SteadyStateChecked`, `chaos.ExperimentCompleted`, `chaos.Aborted` |
| `ci.*` | `ci.ConfigurationChanged`, `ci.RateReattested`, `ci.BudgetOverrun` — account CI configuration, pricing evidence and settlement facts in `packages/ci` |
| `component.*` | `component.Loaded`, `component.Invoked`, `component.Trapped`, `component.TornDown` |
| `compat.*` | `compat.GatePassed`, `compat.GateFailed` |
| `config.*` | `config.Resolved` |
| `conformance.*` | `conformance.RunStarted`, `conformance.CaseChecked`, `conformance.RunCompleted` — replayable port-suite verification in `packages/conformance` |
| `connector.*` | `connector.Registered`, `connector.Disabled` |
| `contract.*` | `contract.Observed`, `contract.Verified`, `contract.EffectDeclared`, `contract.EffectInvoked` |
| `cost.*` | `cost.AnomalyDetected`, `cost.AnomalyResolved`, `cost.ForecastUpdated`, `cost.RecommendationIssued` |
| `credit.*` | `credit.Registered`, `credit.Reset`, `credit.Exhausted`, `credit.BudgetCapSet` |
| `crew.*` | `crew.ActionProposed`, `crew.HandoffRequested` |
| `data.*` | `data.Changed`, `data.Classified` |
| `delta.*` | `delta.Opened`, `delta.Applied` |
| `deploy.*` | `deploy.PreviewUrlAssigned`, `deploy.PreviewTeardownRequested` |
| `dev.*` | `dev.SessionStarted`, `dev.RequestServed`, `dev.HandlerReloaded`, `dev.ReloadFailed`, `dev.CodegenRan`, `dev.SessionStopped` |
| `deployment.*` | `deployment.Planned`, `deployment.PlanRejected`, `deployment.ApplyStarted`, `deployment.ResourceApplied`, `deployment.ApplySucceeded`, `deployment.ApplyFailed`, `deployment.StatusObserved`, `deployment.Deployed`, `deployment.RolledBack`, `deployment.LocalStarted`, `deployment.LocalStopped` (persistent local lifecycle, Protobuf/CUE payloads in `packages/hobo/data-models/composition.*`) |
| `derivative.*` | `derivative.UpgradeStarted`, `derivative.UpgradeSucceeded` |
| `dispatch.*` | `dispatch.Decided`, `dispatch.ReservationReserved`, `dispatch.ReservationConfirmed`, `dispatch.ReservationReleased`, `dispatch.ReservationExpired` |
| `drift.*` | `drift.RemediationRouted`, `drift.DiffProposed` |
| `domain.*` | `domain.Validated`, `domain.CutoverStarted`, `domain.CutoverRefused`, `domain.TtlLowered`, `domain.RoutingChanged`, `domain.RolledBack` |
| `env.*` | `env.Cloned`, `env.Promoted` |
| `erasure.*` | `erasure.Requested`, `erasure.Completed` |
| `eval.*` | `eval.Ran`, `eval.GateFailed` |
| `exec.*` | `exec.Started`, `exec.Succeeded` |
| `experiment.*` | `experiment.Assigned` (sampled), `experiment.Exposed` (sampled), `experiment.Concluded` |
| `flag.*` | `flag.Defined`, `flag.Changed`, `flag.Evaluated` (sampled), `flag.Archived`, `flag.KillSwitch` |
| `gatekeeper.*` | `gatekeeper.Decided` |
| `generated.*` | `generated.ResourcePut`, `generated.ResourceRemoved` — executable generated resource APIs backed by the core EventStore; Protobuf/CUE payloads live in `packages/cli/data-models/project_codegen.*` |
| `gen.*` | `gen.Requested`, `gen.PluginCertified` |
| `golden.*` | `golden.Ran`, `golden.Passed` |
| `governance.*` | `governance.ResidencyEnforced` |
| `guardrail.*` | `guardrail.Blocked` |
| `identity.*` | `identity.Issued`, `identity.Rotated`, `identity.PartitionGraceEntered`, `identity.PartitionGraceExpired`, `identity.MigrationStarted`, `identity.DualLinked`, `identity.ShadowVerified`, `identity.DualConsistencyChecked`, `identity.MigrationProgressed`, `identity.Migrated`, `identity.MigrationCutover`, `identity.MigrationAborted`, `identity.MigrationCompensated` |
| `impl.*` | `impl.Generated`, `impl.Promoted` |
| `incident.*` | `incident.Opened`, `incident.Escalated`, `incident.A2HHandedOff`, `incident.SelfHealAttempted`, `incident.SelfHealDenied`, `incident.Resolved` |
| `inference.*` | `inference.BudgetGateEvaluated`, `inference.BudgetContextMissing` |
| `invoice.*` | `invoice.LineItem`, `invoice.AdjustmentLine`, `invoice.LateUsageAdjustment` |
| `junction.*` | `junction.TrustEstablished`, `junction.ArtifactShared` |
| `lane.*` | `lane.Revoked` |
| `link.*` | `link.Established`, `link.Called`, `link.Rejected` |
| `listing.*` | `listing.Published`, `listing.Certified`, `listing.Yanked` |
| `livefix.*` | `livefix.Proposed`, `livefix.Applied` |
| `match.*` | `match.Decided` |
| `meter.*` | `meter.UsageRecorded` |
| `migration.*` | `migration.Planned`, `migration.SnapshotTaken`, `migration.PhaseIntended`, `migration.PhaseApplied`, `migration.Verified`, `migration.FenceRequested`, `migration.FenceRaised`, `migration.CutOver`, `migration.RollbackDecided`, `migration.RolledBack`, `migration.Failed`, `migration.Exported`, `migration.Imported`, `migration.Held`, `migration.Resumed`, `migration.Completed` — bodies pinned in `packages/events/src/upcaster-corpus.ts` (`MIGRATION_EVENT_CONTRACTS`), each v1 unless listed. **v2, each with an upcaster from v1:** `migration.Planned` (v1 is pinned to what the v1 executors wrote — `phases` as a list, optional `pattern`, `decisionDigest`, `custodyDigest`, `source`, `target`, `dataset`; v2 adds optional `realization` and `profile`; the upcaster keeps everything the plan said, above all the pattern a resume is checked against, and names an in-place plan `in-place-evolve`), `migration.PhaseApplied` (v1 is pinned to what was written — optional `statements`, optional `checkpoint`, which for the cutover phase carried the fence token; v2 withdraws that token, the upcaster replacing it with `fenceTokenDigest`, and adds optional `recovered` for an in-place phase its probe found already in effect), `migration.CutOver` (`fenceToken` withdrawn — it is a write-authority credential — and replaced by `fenceTokenDigest`; `fencedFrom` added; the upcaster digests a v1 token and drops it), `migration.RolledBack` (`snapshotRef` no longer required; optional `lossless`, `erasuresReplayed` added). **Added at v1 ([ADR-0177](./adr/03-data-plane.md#adr-0177)):** the three write-ahead facts — `migration.FenceRequested` (`migrationId`, `side`, `phase`, `requestedAt`), journaled before a fence is raised; `migration.PhaseIntended` (`migrationId`, `phase`, `statements`, `intendedAt`; optional `retry`), journaled before an in-place phase runs its statements; `migration.RollbackDecided` (`migrationId`, `lossless`, `decidedAt`; optional `erasuresFrom`, `count`, `digest`, `targetFenced`, `policyFindings`), journaled before write authority is handed back — and `migration.FenceRaised` (`migrationId`, `side`, `phase`, `fenceTokenDigest`, `raisedAt`), journaled after a raise so a later run can prove a standing fence is its own. **Optional fields added at v1:** `migration.Verified` (`count`, `digest`, `compared`), `migration.Held` (`compensated`, `before`, `failedPhase`), `migration.RollbackDecided` (`targetFenced`, `policyFindings`). `packages/events/test/migration-fact-contracts.test.ts` holds every fact the `@hobo/data-core` executors emit to these contracts, and `@hobo/data-core` lifts an older journal to these bodies on load (`liftMigrationFacts`) |
| `model.*` | `model.Registered`, `model.Promoted` |
| `notification.*` | `notification.Requested`, `notification.Delivered` |
| `pam.*` | `pam.SessionStarted`, `pam.SessionRenewed`, `pam.SessionEnded`, `pam.SessionDenied`, `pam.GatewayStarted`, `pam.GatewayStopped` |
| `pack.*` | `pack.Imported` |
| `pipeline.*` | `pipeline.Triggered`, `pipeline.Completed` |
| `policy.*` | `policy.Decided`, `policy.ObligationCreated`, `policy.ObligationSatisfied`, `policy.WaiverRequested`, `policy.WaiverApproved`, `policy.WaiverExpired`, `policy.WaiverRevoked` |
| `pricing.*` | `pricing.RateCardPublished`, `pricing.ProviderAgreementObserved`, `pricing.GrantObserved`, `pricing.CommitmentObserved`, `pricing.QuoteCreated`, `pricing.ReservationCreated`, `pricing.ReservationConfirmed`, `pricing.ReservationReleased`, `pricing.ReservationExpired`, `pricing.ActualChargeObserved`, `pricing.ReconciliationRecorded`, `pricing.CatalogRegistered` |
| `projection.*` | `projection.Declared`, `projection.Lagged` |
| `provider.*` | `provider.Registered`, `provider.Approved`, `provider.Deprecated` |
| `messaging.*` | `messaging.topic.created`, `messaging.subscription.created`, `messaging.dead_lettered`, `messaging.delivery.permanent_failure` (+ 6 more lowercase literals in `@hobo/core` ports/messaging.ts — naming diverges from `aggregate.PastTenseFact`; rename tracked in GAPS.md REM) |
| `query.*` | `query.*` |
| `redteam.*` | `redteam.FindingRecorded` |
| `registry.*` | `registry.BundleImported` |
| `resource.*` | `resource.Provisioned`, `resource.DriftDetected` |
| `resilience.*` | `resilience.Attempt`, `resilience.Terminal` |
| `resourcedef.*` | `resourcedef.Registered`, `resourcedef.Updated` (design-only: no emitter ships yet — emission from the registry write path is tracked in GAPS.md) |
| `rollout.*` | `rollout.Started`, `rollout.Stepped`, `rollout.Promoted`, `rollout.RolledBack`, `rollout.Failed` (OpenDelivery port, `@hobo/identity`); `@hobo/cd` rollout ledger: `rollout.Lowered`, `rollout.EvidenceObserved`, `rollout.RampStarted`, `rollout.ShiftRequested`, `rollout.Shifted`, `rollout.TrafficObserved`, `rollout.StageVerified`, `rollout.StageApprovalRequested`, `rollout.Held`, `rollout.Released`, `rollout.Advanced`, `rollout.RollbackStarted`, `rollout.RollbackDeltaOpened`, `rollout.Finished`, `rollout.EngineCommanded` (`packages/cd/src/rollout/journal.ts`) |
| `run.*` | `run.Started`, `run.StepCompleted` |
| `runbook.*` | `runbook.Defined`, `runbook.Triggered`, `runbook.Diagnosed`, `runbook.FixBlocked`, `runbook.RemediationStarted`, `runbook.RemediationCompleted`, `runbook.StepCompleted`, `runbook.Completed`, `runbook.Failed` |
| `sdk.*` | `sdk.ExecutionFact` — provider generation and runner execution receipts; Protobuf/CUE payloads in `packages/sdk/data-models/sdk.*` |
| `routing.*` | `routing.ReplanProposed`, `routing.ReplanHeld`, `routing.ReplanDenied`, `routing.Reapplied`, `routing.RampAdvanced` |
| `saga.*` | `saga.Started`, `saga.StepEmitted`, `saga.Completed`, `saga.Compensated` |
| `secret.*` | `secret.Accessed`, `secret.Unavailable` |
| `yard.*` | `yard.Registered`, `yard.MatchDecided`, `yard.Generation*` (generation saga family), plus placement/inventory facts emitted by `@hobo/broker` yard-placement |
| `connection.*` | `connection.Created`, `connection.Authorized`, `connection.TokenIssued`, `connection.Revoked`, `connection.Rotated` |
| `rail.*` | `rail.Published`, `rail.Approved`, `rail.Activated`, `rail.Deactivated`, `rail.Retired` |
| `station.*` | `station.Created`, `station.Configured`, `station.Closed`, `station.IdentityRotated` |
| `session.*` | `session.Started`, `session.Refreshed`, `session.Revoked` |
| `set.*` | `set.Created` |
| `slo.*` | `slo.Declared`, `slo.BudgetBurned` |
| `spend.*` | `spend.Recorded`, `spend.CapGateEvaluated`, `spend.CircuitTripped`, `spend.CircuitReset`, `spend.DegradationRequired`, `spend.DegradationApplied`, `spend.DegradationRolledBack` |
| `statuspage.*` | `statuspage.Published`, `statuspage.IncidentPosted` |
| `stub.*` | `stub.Recorded` |
| `subscription.*` | `subscription.Opened`, `subscription.Pushed`, `subscription.Recomputed`, `subscription.Closed` |
| `support.*` | `support.UsageCorrectionApproved`, `support.DisputeOpened` |
| `tenant.*` | `tenant.Provisioned`, `tenant.Suspended`, `tenant.Resumed`, `tenant.Offboarded`, `tenant.Exported`, `tenant.Imported`, `tenant.Fenced`, `tenant.Drained`, `tenant.Erased`, `tenant.CutoverFailed` |
| `token.*` | `token.Granted`, `token.Used`, `token.Denied`, `token.Revoked` |
| `replay.*` | `replay.Started`, `replay.ChunkIngested`, `replay.Ended`, `replay.ErrorLinked`, `replay.RetentionApplied`, `replay.Accessed`, `replay.Disabled`, `replay.Metered` |
| `trail.*` | `trail.Started`, `trail.Planned`, `trail.DualActive`, `trail.Progressed`, `trail.Validated`, `trail.Cutover`, `trail.Compensated`, `trail.Aborted`, `trail.Failed`, `trail.HistoryRecorded` |
| `training.*` | `training.RunStarted`, `training.Promoted` |
| `user.*` | `user.Authenticated` |
| `ws.*` | `ws.Connected`, `ws.Subscribed` |

## HoBo.CD families (`CD_EVENTS`)

Every event name in `CD_EVENTS` (`packages/cd/src/events.ts`, frozen by plan
0024 Appendix A) is listed here with the `@hobo/cd` module that appends it.
Stream ids come from `CD_STREAMS` in the same file: desired state on
`cd-camp-<campId>`, observations on `cd-camp-status-<campId>`, inventory on
`cd-camp-inventory-<campId>`, compliance on `cd-compliance-<campId>`, and one
stream per Freight, source, publisher, artifact, pipeline, window, promotion,
verification, reconciler, Camp set, placement, fan-out and failover. Bodies are
the protobuf messages in `packages/cd/data-models/cd.proto`. Some families
(`camp.*`, `delta.*`, `deployment.*`, `env.*`, `pipeline.*`, `policy.*`,
`rollout.*`, `set.*`) already appear above for other packages; the CD names
extend them. Design: [continuous-delivery.md](./continuous-delivery.md),
[ADR-0181](./adr/01-architecture-core.md#adr-0181).

| Family | `CD_EVENTS` names | Appended by (`packages/cd/src/`) |
|---|---|---|
| `freight.*` | `freight.Recorded`, `freight.Yanked`, `freight.Qualified`, `freight.Approved`, `freight.Retired` | `freight/` |
| `source.*` | `source.Defined`, `source.ArtifactDiscovered` | `sources/` |
| `publisher.*` | `publisher.Trusted` | `ingest/` |
| `artifact.*` | `artifact.Stored`, `artifact.Deleted` | `artifacts/` |
| `set.*` | `set.Created` | `sets/` (and `freight/` for a recorded Set) |
| `delta.*` | `delta.Opened`, `delta.Updated`, `delta.Applied`, `delta.Rejected` | `sets/` |
| `pipeline.*` | `pipeline.Applied`, `pipeline.FreightAvailable` | `pipelines/` |
| `window.*` | `window.Defined`, `window.Overridden` | `windows/` |
| `env.*` | `env.PromoteRequested`, `env.Promoted`, `env.PromoteRolledBack`, `env.PromoteRejected`, `env.PromoteSuperseded`, `env.Cloned`, `env.Expired` | `promotion/` |
| `verification.*` | `verification.Started`, `verification.Completed` | `verification/` |
| `rollout.*` | `rollout.Lowered`, `rollout.EvidenceObserved` | `rollout/` (`Lowered`), `verification/` (`EvidenceObserved`) |
| `reconciler.*` | `reconciler.Enrolled`, `reconciler.Revoked`, `reconciler.EnrollmentRequested`, `reconciler.KeyApproved`, `reconciler.Accepted` | `agent/` (enrollment) |
| `deployment.*` | `deployment.ReconcileStarted`, `deployment.StatusObserved`, `deployment.Converged`, `deployment.ReconcileBlocked` | `reconcile/` (Camp status stream) |
| `camp.*` | `camp.StatusChanged`, `camp.Tainted`, `camp.Untainted`, `camp.ManagementChanged`, `camp.Departed` | `inventory/` (`Departed`: `fanout/`) |
| `campset.*` | `campset.Defined` | `inventory/` |
| `placement.*` | `placement.Defined`, `placement.ScoresReported`, `placement.Decided` | `placement/` |
| `fanout.*` | `fanout.Started`, `fanout.Progressed`, `fanout.Halted`, `fanout.Resumed`, `fanout.Completed`, `fanout.RolledBack` | `fanout/` |
| `failover.*` | `failover.Proposed`, `failover.Started`, `failover.Progressed`, `failover.Completed`, `failover.Refused` | `failover/` |
| `rebalance.*` | `rebalance.Requested` | `failover/` |
| `policy.*` | `policy.BindingChanged`, `policy.ShadowDecided` | `posture/` |
| `compliance.*` | `compliance.Observed`, `compliance.Changed` | `posture/` |
| `posture.*` | `posture.RemediationProposed` | `posture/` |
