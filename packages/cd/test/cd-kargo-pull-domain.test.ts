import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
	AbortStageVerification,
	ApprovalExpiryInvalid,
	ApproveDeliveryRun,
	ApproveFreightForStage,
	ApproverId,
	BranchName,
	CampTargetId,
	CdCampRealizer,
	CdDeliveryFlow,
	CdDeliveryRun,
	type CdDeliveryRunStatusState,
	CdDeliveryRunStatusView,
	CdFreight,
	type CdFreightCatalogState,
	CdFreightCatalogView,
	CdPromotionId,
	CdRelease,
	CdReleaseHandlers,
	CdStage,
	CdStageConfigured,
	type CdStageStatusState,
	CdStageStatusView,
	CdVerificationGate,
	ConfigureCdStage,
	ConvergenceObservedSignal,
	DeliveryConvergenceObserved,
	DeliveryFlowTarget,
	DeliveryPullRequestMerged,
	DeliveryPullRequestOpened,
	DeliveryRevisionCommitted,
	DeliveryRunApproved,
	DeliveryRunCompleted,
	DeliveryRunFailed,
	DeliveryRunId,
	DeliveryRunRolledBack,
	DeliveryRunStarted,
	DeliveryRunVerified,
	EpochMs,
	ExecuteCdDeliveryFlow,
	FreightAlias,
	FreightAliasUpdated,
	FreightAlreadyYanked,
	FreightDigest,
	FreightManuallyApproved,
	FreightNotEligibleForStage,
	FreightQualifiedInStage,
	FreightRecorded,
	FreightYanked,
	InvalidStageConfiguration,
	NonEmptyReason,
	NonNegativeCount,
	PositiveCount,
	PullRequestId,
	PullRequestResolvedSignal,
	PullRequestUrl,
	RealizationRef,
	RecordFreight,
	RequestStagePromotion,
	ReverifyStageFreight,
	RevisionRef,
	SetFreightAlias,
	SoakTimeNotElapsed,
	StageEnteredVerifying,
	StageId,
	StagePromotionCompleted,
	StagePromotionFailed,
	StagePromotionQueued,
	StagePromotionStarted,
	StagePromotionSuperseded,
	StageReverificationStarted,
	StageVerificationAborted,
	UniqueStageList,
	WarehouseId,
	YankFreight,
} from "../src/domain/index.js";

const story = Story.make(CdRelease, {
	layer: CdReleaseHandlers,
	stub: [CdCampRealizer, CdVerificationGate, CdDeliveryFlow],
});

type CdDeliveryFlowService = Layer.Success<
	ReturnType<typeof CdDeliveryFlow.toLayer>
>;

function runDeliveryFlowConformance(
	adapterName: string,
	layer: Layer.Layer<CdDeliveryFlowService>,
) {
	describe(`CdDeliveryFlow adapter conformance: ${adapterName}`, () => {
		it("publishes, observes convergence, and rolls back a revision through the typed ExternalSystem contract", async () => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const flow = yield* CdDeliveryFlow;
					const published = yield* flow.publishRevision({
						deliveryRunId: DeliveryRunId.make("run-conf-1"),
						stageId: StageId.make("stage-dev"),
						campId: CampTargetId.make("camp-dev"),
						freightDigest: FreightDigest.make("sha256:conf-v1"),
						flowKind: "gitops-pull",
						flowTarget: DeliveryFlowTarget.make("gitops-engine"),
						previousRevision: null,
					});
					const rev = published.outcome.revision;
					const converged = yield* flow.observeConvergence({
						deliveryRunId: DeliveryRunId.make("run-conf-1"),
						stageId: StageId.make("stage-dev"),
						campId: CampTargetId.make("camp-dev"),
						flowKind: "gitops-pull",
						flowTarget: DeliveryFlowTarget.make("gitops-engine"),
						targetRevision: rev,
						triggerSync: false,
					});
					const rolledBack = yield* flow.rollbackRevision({
						deliveryRunId: DeliveryRunId.make("run-conf-1"),
						stageId: StageId.make("stage-dev"),
						campId: CampTargetId.make("camp-dev"),
						flowKind: "gitops-pull",
						flowTarget: DeliveryFlowTarget.make("gitops-engine"),
						targetRevision: rev,
						previousRevision: null,
						reason: NonEmptyReason.make("conformance-rollback"),
					});
					return { published, converged, rolledBack };
				}).pipe(Effect.provide(layer)),
			);

			expect(result.published.outcome.revision.length).toBeGreaterThan(0);
			expect(result.converged.observation._tag).toBe("Converged");
			expect(result.rolledBack.rolledBack).toBe(true);
		});
	});
}

describe("@hobo/cd/domain Kargo-parity and pull-based CD release model", () => {
	it("passes Domain.verify static model verification with Freight, Stage, and DeliveryRun", () => {
		expect(Domain.verify(CdRelease)).toEqual([]);
	});

	it("enforces branded Kargo and pull-flow domain types and discriminated views at compile time and schema boundaries", () => {
		const checkCompileTimeConstraints = (
			freightView: CdFreightCatalogState,
			stageView: CdStageStatusState,
			runView: CdDeliveryRunStatusState,
		) => {
			// @ts-expect-error raw string is not a branded StageId
			const badStage: StageId = "prod";
			// @ts-expect-error raw string is not a branded FreightAlias
			const badAlias: FreightAlias = "calm-otter";
			// @ts-expect-error raw string is not a branded PullRequestUrl
			const badPrUrl: PullRequestUrl = "https://example.test/pr/1";
			// @ts-expect-error alias does not exist on unnarrowed CdFreightCatalogState
			const unnarrowedAlias = freightView.alias;
			// @ts-expect-error activeRunId does not exist on unnarrowed CdStageStatusState
			const unnarrowedRun = stageView.activeRunId;
			// @ts-expect-error prUrl does not exist on unnarrowed CdDeliveryRunStatusState
			const unnarrowedPr = runView.prUrl;
			return [
				badStage,
				badAlias,
				badPrUrl,
				unnarrowedAlias,
				unnarrowedRun,
				unnarrowedPr,
			];
		};
		expect(checkCompileTimeConstraints).toBeTypeOf("function");

		expect(
			Exit.isFailure(Schema.decodeUnknownExit(FreightAlias)("INVALID_ALIAS")),
		).toBe(true);
		expect(
			Exit.isFailure(Schema.decodeUnknownExit(PullRequestUrl)("http://no-tls")),
		).toBe(true);
		expect(
			Exit.isFailure(Schema.decodeUnknownExit(UniqueStageList)(["dev", "dev"])),
		).toBe(true);
		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(UniqueStageList)(["dev", "staging"]),
			),
		).toBe(true);
	});

	it("manages Freight warehouse origin, alias updates, expiring manual approvals, and yanking", async () => {
		const digest = FreightDigest.make("sha256:freight-bundle-1");
		const freight = CdFreight.ref(digest);
		const warehouseId = WarehouseId.make("wh-core-api");
		const initialAlias = FreightAlias.make("amber-badger");
		const customAlias = FreightAlias.make("release-2026-11");
		const prodStage = StageId.make("prod");
		const approver = ApproverId.make("sre-lead");
		const t0 = EpochMs.make(1_700_000_000_000);
		const t1 = EpochMs.make(1_700_003_600_000);
		const artifact = {
			kind: "oci-image" as const,
			repository: "ghcr.io/hobo/api",
			reference: "1.4.0",
			digest,
		};

		await Effect.runPromise(
			story(
				Story.when(
					freight,
					new RecordFreight({
						warehouseId,
						alias: initialAlias,
						artifacts: [artifact],
						recordedAtMs: t0,
					}),
				),
				Story.then(
					freight,
					new FreightRecorded({
						warehouseId,
						alias: initialAlias,
						artifacts: [artifact],
						recordedAtMs: t0,
					}),
				),
				Story.when(freight, new SetFreightAlias({ alias: customAlias })),
				Story.then(
					freight,
					new FreightAliasUpdated({
						previousAlias: initialAlias,
						alias: customAlias,
					}),
				),
				Story.when(
					freight,
					new ApproveFreightForStage({
						stageId: prodStage,
						approver,
						reason: NonEmptyReason.make("bad-window"),
						approvedAtMs: t1,
						expiresAtMs: t0,
					}),
				),
				Story.rejected(
					new ApprovalExpiryInvalid({ approvedAtMs: t1, expiresAtMs: t0 }),
				),
				Story.when(
					freight,
					new ApproveFreightForStage({
						stageId: prodStage,
						approver,
						reason: NonEmptyReason.make("hotfix-cve-2026"),
						approvedAtMs: t0,
						expiresAtMs: t1,
					}),
				),
				Story.then(
					freight,
					new FreightManuallyApproved({
						stageId: prodStage,
						approver,
						reason: NonEmptyReason.make("hotfix-cve-2026"),
						approvedAtMs: t0,
						expiresAtMs: t1,
					}),
				),
				Story.when(
					freight,
					new YankFreight({
						reason: NonEmptyReason.make("regression-found"),
						yankedAtMs: t1,
					}),
				),
				Story.then(
					freight,
					new FreightYanked({
						reason: NonEmptyReason.make("regression-found"),
						yankedAtMs: t1,
					}),
				),
				Story.when(
					freight,
					new SetFreightAlias({ alias: FreightAlias.make("too-late") }),
				),
				Story.rejected(
					new FreightAlreadyYanked({
						reason: NonEmptyReason.make("regression-found"),
					}),
				),
				Story.view(CdFreightCatalogView, freight, {
					_tag: "Yanked",
					warehouseId,
					alias: customAlias,
					reason: NonEmptyReason.make("regression-found"),
					yankedAtMs: t1,
				}),
			),
		);
	});

	it("runs end-to-end Kargo lineage: direct pull dev stage -> soak gate -> PR-based pull prod stage with signals and qualification", async () => {
		const clockIso = "2026-11-24T00:00:00.000Z";
		const clockMs = EpochMs.make(Date.parse(clockIso));
		const soakMs = NonNegativeCount.make(300_000);
		const afterSoakMs = EpochMs.make(clockMs + soakMs);
		const warehouseId = WarehouseId.make("wh-app");
		const digest = FreightDigest.make("sha256:app-v2");
		const alias = FreightAlias.make("swift-heron");
		const devStage = CdStage.ref(StageId.make("dev"));
		const prodStage = CdStage.ref(StageId.make("prod"));
		const freight = CdFreight.ref(digest);
		const devRun = CdDeliveryRun.ref(DeliveryRunId.make("run-dev-1"));
		const prodRun = CdDeliveryRun.ref(DeliveryRunId.make("run-prod-1"));
		const devCamp = CampTargetId.make("camp-dev");
		const prodCamp = CampTargetId.make("camp-prod");
		const flowTarget = DeliveryFlowTarget.make("gitops-pull-primary");
		const devRev = RevisionRef.make("commit-dev-111");
		const prRev = RevisionRef.make("commit-pr-head-222");
		const mergeRev = RevisionRef.make("commit-prod-merge-333");
		const prId = PullRequestId.make("pr-42");
		const prUrl = PullRequestUrl.make(
			"https://git.example.test/org/repo/pull/42",
		);
		const headBranch = BranchName.make("hobo/promote/prod/run-prod-1");
		const targetRef = NonEmptyReason.make("gitops:org/repo@main");

		const devConfig = {
			warehouseId,
			upstreamStages: UniqueStageList.make([]),
			availabilityStrategy: "direct" as const,
			quorumCount: null,
			requiredSoakMs: NonNegativeCount.make(0),
			autoPromotion: "newest" as const,
			deliveryFlow: "gitops-pull" as const,
			flowTarget,
			campId: devCamp,
			requiresApproval: false,
			implicitHealthVerification: true,
			triggerPullSync: false,
		};

		const prodConfig = {
			warehouseId: null,
			upstreamStages: UniqueStageList.make([devStage.id]),
			availabilityStrategy: "all" as const,
			quorumCount: null,
			requiredSoakMs: soakMs,
			autoPromotion: "manual" as const,
			deliveryFlow: "gitops-pr-pull" as const,
			flowTarget,
			campId: prodCamp,
			requiresApproval: true,
			implicitHealthVerification: false,
			triggerPullSync: true,
		};

		await Effect.runPromise(
			story(
				Story.clock(clockIso),
				Story.given(
					freight,
					new FreightRecorded({
						warehouseId,
						alias,
						artifacts: [
							{
								kind: "oci-image",
								repository: "ghcr.io/hobo/web",
								reference: "2.0.0",
								digest,
							},
						],
						recordedAtMs: clockMs,
					}),
				),
				Story.when(
					prodStage,
					new ConfigureCdStage({
						config: {
							...prodConfig,
							availabilityStrategy: "quorum",
							quorumCount: PositiveCount.make(3),
						},
					}),
				),
				Story.rejected(
					new InvalidStageConfiguration({
						reason: NonEmptyReason.make(
							"quorum-count-exceeds-upstream-stage-count",
						),
					}),
				),
				Story.when(devStage, new ConfigureCdStage({ config: devConfig })),
				Story.then(devStage, new CdStageConfigured({ config: devConfig })),
				Story.when(prodStage, new ConfigureCdStage({ config: prodConfig })),
				Story.then(prodStage, new CdStageConfigured({ config: prodConfig })),
				Story.when(
					prodStage,
					new RequestStagePromotion({
						deliveryRunId: prodRun.id,
						freightDigest: digest,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.rejected(
					new FreightNotEligibleForStage({
						freightDigest: digest,
						reason: NonEmptyReason.make(
							"upstream-qualification-insufficient:0/1",
						),
					}),
				),
				Story.when(
					devStage,
					new RequestStagePromotion({
						deliveryRunId: devRun.id,
						freightDigest: digest,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					devStage,
					new StagePromotionStarted({
						deliveryRunId: devRun.id,
						freightDigest: digest,
						previousFreightDigest: null,
						campId: devCamp,
						deliveryFlow: "gitops-pull",
						flowTarget,
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.then(
					devRun,
					new DeliveryRunStarted({
						stageId: devStage.id,
						campId: devCamp,
						freightDigest: digest,
						previousRevision: null,
						flowKind: "gitops-pull",
						flowTarget,
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.call(CdDeliveryFlow.publishRevision, {
					deliveryRunId: devRun.id,
					stageId: devStage.id,
					campId: devCamp,
					freightDigest: digest,
					flowKind: "gitops-pull",
					flowTarget,
					previousRevision: null,
				}),
				Story.succeed(CdDeliveryFlow.publishRevision, {
					outcome: { _tag: "Committed", revision: devRev, targetRef },
				}),
				Story.then(
					devRun,
					new DeliveryRevisionCommitted({ revision: devRev, targetRef }),
				),
				Story.call(CdDeliveryFlow.observeConvergence, {
					deliveryRunId: devRun.id,
					stageId: devStage.id,
					campId: devCamp,
					flowKind: "gitops-pull",
					flowTarget,
					targetRevision: devRev,
					triggerSync: false,
				}),
				Story.succeed(CdDeliveryFlow.observeConvergence, {
					observation: {
						_tag: "Converged",
						appliedRevision: devRev,
						summary: NonEmptyReason.make("pull-engine-synced-and-healthy"),
					},
				}),
				Story.then(
					devRun,
					new DeliveryConvergenceObserved({
						appliedRevision: devRev,
						outOfSyncCount: NonNegativeCount.make(0),
						summary: NonEmptyReason.make("pull-engine-synced-and-healthy"),
					}),
					new DeliveryRunVerified({
						passed: true,
						implicit: true,
						summary: NonEmptyReason.make("pull-engine-synced-and-healthy"),
						verifiedAtMs: clockMs,
					}),
					new DeliveryRunCompleted({
						stageId: devStage.id,
						freightDigest: digest,
						appliedRevision: devRev,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("pull-engine-synced-and-healthy"),
					}),
				),
				Story.then(
					freight,
					new FreightQualifiedInStage({
						stageId: devStage.id,
						deliveryRunId: devRun.id,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("pull-engine-synced-and-healthy"),
					}),
				),
				Story.then(
					devStage,
					new StageEnteredVerifying({
						deliveryRunId: devRun.id,
						freightDigest: digest,
					}),
					new StagePromotionCompleted({
						deliveryRunId: devRun.id,
						freightDigest: digest,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("pull-engine-synced-and-healthy"),
					}),
				),
				Story.when(
					prodStage,
					new RequestStagePromotion({
						deliveryRunId: prodRun.id,
						freightDigest: digest,
						nowMs: EpochMs.make(clockMs + 60_000),
						upstreamQualifications: [
							{ stageId: devStage.id, qualifiedAtMs: clockMs },
						],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.rejected(
					new SoakTimeNotElapsed({
						freightDigest: digest,
						earliestEligibleAtMs: afterSoakMs,
						nowMs: EpochMs.make(clockMs + 60_000),
					}),
				),
				Story.advance("5 minutes"),
				Story.when(
					prodStage,
					new RequestStagePromotion({
						deliveryRunId: prodRun.id,
						freightDigest: digest,
						nowMs: afterSoakMs,
						upstreamQualifications: [
							{ stageId: devStage.id, qualifiedAtMs: clockMs },
						],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					prodStage,
					new StagePromotionStarted({
						deliveryRunId: prodRun.id,
						freightDigest: digest,
						previousFreightDigest: null,
						campId: prodCamp,
						deliveryFlow: "gitops-pr-pull",
						flowTarget,
						requiresApproval: true,
						implicitHealthVerification: false,
						triggerPullSync: true,
						requestedAtMs: afterSoakMs,
					}),
				),
				Story.then(
					prodRun,
					new DeliveryRunStarted({
						stageId: prodStage.id,
						campId: prodCamp,
						freightDigest: digest,
						previousRevision: null,
						flowKind: "gitops-pr-pull",
						flowTarget,
						requiresApproval: true,
						implicitHealthVerification: false,
						triggerPullSync: true,
						requestedAtMs: afterSoakMs,
					}),
				),
				Story.view(CdDeliveryRunStatusView, prodRun, {
					_tag: "PendingApproval",
					stageId: prodStage.id,
					campId: prodCamp,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
				}),
				Story.when(
					prodRun,
					new ApproveDeliveryRun({ approver: ApproverId.make("release-mgr") }),
				),
				Story.then(
					prodRun,
					new DeliveryRunApproved({
						approver: ApproverId.make("release-mgr"),
						stageId: prodStage.id,
						campId: prodCamp,
						freightDigest: digest,
						previousRevision: null,
						flowKind: "gitops-pr-pull",
						flowTarget,
						implicitHealthVerification: false,
						triggerPullSync: true,
						requestedAtMs: afterSoakMs,
					}),
				),
				Story.call(CdDeliveryFlow.publishRevision, {
					deliveryRunId: prodRun.id,
					stageId: prodStage.id,
					campId: prodCamp,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					previousRevision: null,
				}),
				Story.succeed(CdDeliveryFlow.publishRevision, {
					outcome: {
						_tag: "PullRequestOpened",
						revision: prRev,
						prId,
						prUrl,
						headBranch,
						targetRef,
					},
				}),
				Story.then(
					prodRun,
					new DeliveryPullRequestOpened({
						revision: prRev,
						prId,
						prUrl,
						headBranch,
						targetRef,
					}),
				),
				Story.call(CdDeliveryFlow.observePullRequest, {
					deliveryRunId: prodRun.id,
					flowKind: "gitops-pr-pull",
					flowTarget,
					prId,
					targetRef,
				}),
				Story.succeed(CdDeliveryFlow.observePullRequest, {
					observation: {
						_tag: "Open",
						summary: NonEmptyReason.make("awaiting-pr-approval"),
					},
				}),
				Story.view(CdDeliveryRunStatusView, prodRun, {
					_tag: "AwaitingPullRequest",
					stageId: prodStage.id,
					campId: prodCamp,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					prId,
					prUrl,
					headBranch,
				}),
				Story.signal(
					ExecuteCdDeliveryFlow,
					prodRun,
					PullRequestResolvedSignal,
					{
						_tag: "Merged",
						mergeRevision: mergeRev,
						summary: NonEmptyReason.make("pr-42-merged"),
					},
				),
				Story.then(
					prodRun,
					new DeliveryPullRequestMerged({
						prId,
						mergeRevision: mergeRev,
						summary: NonEmptyReason.make("pr-42-merged"),
					}),
				),
				Story.call(CdDeliveryFlow.observeConvergence, {
					deliveryRunId: prodRun.id,
					stageId: prodStage.id,
					campId: prodCamp,
					flowKind: "gitops-pr-pull",
					flowTarget,
					targetRevision: mergeRev,
					triggerSync: true,
				}),
				Story.succeed(CdDeliveryFlow.observeConvergence, {
					observation: {
						_tag: "Converging",
						appliedRevision: devRev,
						outOfSyncCount: NonNegativeCount.make(2),
						summary: NonEmptyReason.make("syncing-2-resources"),
					},
				}),
				Story.view(CdDeliveryRunStatusView, prodRun, {
					_tag: "AwaitingConvergence",
					stageId: prodStage.id,
					campId: prodCamp,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					targetRevision: mergeRev,
					prId,
				}),
				Story.signal(
					ExecuteCdDeliveryFlow,
					prodRun,
					ConvergenceObservedSignal,
					{
						_tag: "Converged",
						appliedRevision: mergeRev,
						summary: NonEmptyReason.make("all-apps-synced-healthy"),
					},
				),
				Story.then(
					prodRun,
					new DeliveryConvergenceObserved({
						appliedRevision: mergeRev,
						outOfSyncCount: NonNegativeCount.make(0),
						summary: NonEmptyReason.make("all-apps-synced-healthy"),
					}),
				),
				Story.then(
					prodStage,
					new StageEnteredVerifying({
						deliveryRunId: prodRun.id,
						freightDigest: digest,
					}),
				),
				Story.call(CdVerificationGate.evaluate, {
					promotionId: CdPromotionId.make(prodRun.id),
					campId: prodCamp,
					realizationRef: RealizationRef.make(mergeRev),
				}),
				Story.succeed(CdVerificationGate.evaluate, {
					passed: true,
					summary: NonEmptyReason.make("prod-slo-green"),
				}),
				Story.then(
					prodRun,
					new DeliveryRunVerified({
						passed: true,
						implicit: false,
						summary: NonEmptyReason.make("prod-slo-green"),
						verifiedAtMs: afterSoakMs,
					}),
					new DeliveryRunCompleted({
						stageId: prodStage.id,
						freightDigest: digest,
						appliedRevision: mergeRev,
						qualifiedAtMs: afterSoakMs,
						summary: NonEmptyReason.make("prod-slo-green"),
					}),
				),
				Story.then(
					freight,
					new FreightQualifiedInStage({
						stageId: prodStage.id,
						deliveryRunId: prodRun.id,
						qualifiedAtMs: afterSoakMs,
						summary: NonEmptyReason.make("prod-slo-green"),
					}),
				),
				Story.then(
					prodStage,
					new StagePromotionCompleted({
						deliveryRunId: prodRun.id,
						freightDigest: digest,
						qualifiedAtMs: afterSoakMs,
						summary: NonEmptyReason.make("prod-slo-green"),
					}),
				),
				Story.view(CdDeliveryRunStatusView, prodRun, {
					_tag: "Completed",
					stageId: prodStage.id,
					campId: prodCamp,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					appliedRevision: mergeRev,
					qualifiedAtMs: afterSoakMs,
					summary: NonEmptyReason.make("prod-slo-green"),
				}),
				Story.view(CdStageStatusView, prodStage, {
					_tag: "Idle",
					config: prodConfig,
					currentFreightDigest: digest,
					currentVerified: true,
					lastVerifiedAtMs: afterSoakMs,
				}),
			),
		);
	});

	it("fails closed when a promotion PR is closed without merge and rolls back on degraded convergence", async () => {
		const clockIso = "2026-11-24T01:00:00.000Z";
		const clockMs = EpochMs.make(Date.parse(clockIso));
		const stage = CdStage.ref(StageId.make("staging"));
		const campId = CampTargetId.make("camp-staging");
		const flowTarget = DeliveryFlowTarget.make("gitops-pull-primary");
		const digest = FreightDigest.make("sha256:app-v3");
		const prClosedRun = CdDeliveryRun.ref(DeliveryRunId.make("run-pr-closed"));
		const degradedRun = CdDeliveryRun.ref(DeliveryRunId.make("run-degraded"));
		const targetRef = NonEmptyReason.make("gitops:org/repo@staging");
		const prId = PullRequestId.make("pr-99");
		const prUrl = PullRequestUrl.make(
			"https://git.example.test/org/repo/pull/99",
		);
		const headBranch = BranchName.make("hobo/promote/staging/run-pr-closed");
		const rev1 = RevisionRef.make("commit-pr-99");
		const rev2 = RevisionRef.make("commit-bad-222");
		const rollbackRev = RevisionRef.make("commit-revert-333");

		const stageConfig = {
			warehouseId: WarehouseId.make("wh-app"),
			upstreamStages: UniqueStageList.make([]),
			availabilityStrategy: "direct" as const,
			quorumCount: null,
			requiredSoakMs: NonNegativeCount.make(0),
			autoPromotion: "newest" as const,
			deliveryFlow: "gitops-pr-pull" as const,
			flowTarget,
			campId,
			requiresApproval: false,
			implicitHealthVerification: true,
			triggerPullSync: false,
		};

		await Effect.runPromise(
			story(
				Story.clock(clockIso),
				Story.given(stage, new CdStageConfigured({ config: stageConfig })),
				Story.when(
					stage,
					new RequestStagePromotion({
						deliveryRunId: prClosedRun.id,
						freightDigest: digest,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					stage,
					new StagePromotionStarted({
						deliveryRunId: prClosedRun.id,
						freightDigest: digest,
						previousFreightDigest: null,
						campId,
						deliveryFlow: "gitops-pr-pull",
						flowTarget,
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.then(
					prClosedRun,
					new DeliveryRunStarted({
						stageId: stage.id,
						campId,
						freightDigest: digest,
						previousRevision: null,
						flowKind: "gitops-pr-pull",
						flowTarget,
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.call(CdDeliveryFlow.publishRevision, {
					deliveryRunId: prClosedRun.id,
					stageId: stage.id,
					campId,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					previousRevision: null,
				}),
				Story.succeed(CdDeliveryFlow.publishRevision, {
					outcome: {
						_tag: "PullRequestOpened",
						revision: rev1,
						prId,
						prUrl,
						headBranch,
						targetRef,
					},
				}),
				Story.then(
					prClosedRun,
					new DeliveryPullRequestOpened({
						revision: rev1,
						prId,
						prUrl,
						headBranch,
						targetRef,
					}),
				),
				Story.call(CdDeliveryFlow.observePullRequest, {
					deliveryRunId: prClosedRun.id,
					flowKind: "gitops-pr-pull",
					flowTarget,
					prId,
					targetRef,
				}),
				Story.succeed(CdDeliveryFlow.observePullRequest, {
					observation: {
						_tag: "Closed",
						summary: NonEmptyReason.make("pr-rejected-by-reviewer"),
					},
				}),
				Story.then(
					prClosedRun,
					new DeliveryRunFailed({
						stageId: stage.id,
						freightDigest: digest,
						reason: NonEmptyReason.make(
							"pull-request-not-merged:pr-rejected-by-reviewer",
						),
					}),
				),
				Story.then(
					stage,
					new StagePromotionFailed({
						deliveryRunId: prClosedRun.id,
						freightDigest: digest,
						reason: NonEmptyReason.make(
							"pull-request-not-merged:pr-rejected-by-reviewer",
						),
					}),
				),
				Story.when(
					stage,
					new RequestStagePromotion({
						deliveryRunId: degradedRun.id,
						freightDigest: digest,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					stage,
					new StagePromotionStarted({
						deliveryRunId: degradedRun.id,
						freightDigest: digest,
						previousFreightDigest: null,
						campId,
						deliveryFlow: "gitops-pr-pull",
						flowTarget,
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.then(
					degradedRun,
					new DeliveryRunStarted({
						stageId: stage.id,
						campId,
						freightDigest: digest,
						previousRevision: null,
						flowKind: "gitops-pr-pull",
						flowTarget,
						requiresApproval: false,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.call(CdDeliveryFlow.publishRevision, {
					deliveryRunId: degradedRun.id,
					stageId: stage.id,
					campId,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					previousRevision: null,
				}),
				Story.succeed(CdDeliveryFlow.publishRevision, {
					outcome: { _tag: "Committed", revision: rev2, targetRef },
				}),
				Story.then(
					degradedRun,
					new DeliveryRevisionCommitted({ revision: rev2, targetRef }),
				),
				Story.call(CdDeliveryFlow.observeConvergence, {
					deliveryRunId: degradedRun.id,
					stageId: stage.id,
					campId,
					flowKind: "gitops-pr-pull",
					flowTarget,
					targetRevision: rev2,
					triggerSync: false,
				}),
				Story.succeed(CdDeliveryFlow.observeConvergence, {
					observation: {
						_tag: "Degraded",
						appliedRevision: rev2,
						outOfSyncCount: NonNegativeCount.make(1),
						summary: NonEmptyReason.make("crashloopbackoff"),
					},
				}),
				Story.call(CdDeliveryFlow.rollbackRevision, {
					deliveryRunId: degradedRun.id,
					stageId: stage.id,
					campId,
					flowKind: "gitops-pr-pull",
					flowTarget,
					targetRevision: rev2,
					previousRevision: null,
					reason: NonEmptyReason.make(
						"pull-convergence-degraded:crashloopbackoff",
					),
				}),
				Story.succeed(CdDeliveryFlow.rollbackRevision, {
					rolledBack: true,
					rollbackRevision: rollbackRev,
					summary: NonEmptyReason.make("reverted-manifest-commit"),
				}),
				Story.then(
					degradedRun,
					new DeliveryRunRolledBack({
						stageId: stage.id,
						freightDigest: digest,
						rollbackRevision: rollbackRev,
						reason: NonEmptyReason.make(
							"pull-convergence-degraded:crashloopbackoff",
						),
					}),
				),
				Story.then(
					stage,
					new StagePromotionFailed({
						deliveryRunId: degradedRun.id,
						freightDigest: digest,
						reason: NonEmptyReason.make(
							"pull-convergence-degraded:crashloopbackoff",
						),
					}),
				),
				Story.view(CdDeliveryRunStatusView, degradedRun, {
					_tag: "RolledBack",
					stageId: stage.id,
					campId,
					freightDigest: digest,
					flowKind: "gitops-pr-pull",
					flowTarget,
					rollbackRevision: rollbackRev,
					reason: NonEmptyReason.make(
						"pull-convergence-degraded:crashloopbackoff",
					),
				}),
			),
		);
	});

	it("supersedes queued Freight while Stage is active and supports re-verification and abort", async () => {
		const clockIso = "2026-11-24T02:00:00.000Z";
		const clockMs = EpochMs.make(Date.parse(clockIso));
		const stage = CdStage.ref(StageId.make("canary"));
		const campId = CampTargetId.make("camp-canary");
		const flowTarget = DeliveryFlowTarget.make("gitops-pull-primary");
		const d1 = FreightDigest.make("sha256:f1");
		const d2 = FreightDigest.make("sha256:f2");
		const d3 = FreightDigest.make("sha256:f3");
		const r1 = CdDeliveryRun.ref(DeliveryRunId.make("run-1"));
		const r2 = DeliveryRunId.make("run-2");
		const r3 = CdDeliveryRun.ref(DeliveryRunId.make("run-3"));
		const reverifyId = DeliveryRunId.make("reverify-1");
		const rev1 = RevisionRef.make("rev-1");
		const rev3 = RevisionRef.make("rev-3");
		const targetRef = NonEmptyReason.make("gitops:org/repo@canary");

		const stageConfig = {
			warehouseId: WarehouseId.make("wh-app"),
			upstreamStages: UniqueStageList.make([]),
			availabilityStrategy: "direct" as const,
			quorumCount: null,
			requiredSoakMs: NonNegativeCount.make(0),
			autoPromotion: "newest" as const,
			deliveryFlow: "gitops-pull" as const,
			flowTarget,
			campId,
			requiresApproval: true,
			implicitHealthVerification: true,
			triggerPullSync: false,
		};

		await Effect.runPromise(
			story(
				Story.clock(clockIso),
				Story.given(stage, new CdStageConfigured({ config: stageConfig })),
				Story.when(
					stage,
					new RequestStagePromotion({
						deliveryRunId: r1.id,
						freightDigest: d1,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					stage,
					new StagePromotionStarted({
						deliveryRunId: r1.id,
						freightDigest: d1,
						previousFreightDigest: null,
						campId,
						deliveryFlow: "gitops-pull",
						flowTarget,
						requiresApproval: true,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.then(
					r1,
					new DeliveryRunStarted({
						stageId: stage.id,
						campId,
						freightDigest: d1,
						previousRevision: null,
						flowKind: "gitops-pull",
						flowTarget,
						requiresApproval: true,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.when(
					stage,
					new RequestStagePromotion({
						deliveryRunId: r2,
						freightDigest: d2,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					stage,
					new StagePromotionQueued({
						deliveryRunId: r2,
						freightDigest: d2,
						requestedAtMs: clockMs,
					}),
				),
				Story.when(
					stage,
					new RequestStagePromotion({
						deliveryRunId: r3.id,
						freightDigest: d3,
						nowMs: clockMs,
						upstreamQualifications: [],
						manualApprovalExpiresAtMs: null,
					}),
				),
				Story.then(
					stage,
					new StagePromotionSuperseded({
						supersededRunId: r2,
						supersededFreightDigest: d2,
						replacementRunId: r3.id,
						replacementFreightDigest: d3,
					}),
					new StagePromotionQueued({
						deliveryRunId: r3.id,
						freightDigest: d3,
						requestedAtMs: clockMs,
					}),
				),
				Story.when(
					r1,
					new ApproveDeliveryRun({ approver: ApproverId.make("ops") }),
				),
				Story.then(
					r1,
					new DeliveryRunApproved({
						approver: ApproverId.make("ops"),
						stageId: stage.id,
						campId,
						freightDigest: d1,
						previousRevision: null,
						flowKind: "gitops-pull",
						flowTarget,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.call(CdDeliveryFlow.publishRevision, {
					deliveryRunId: r1.id,
					stageId: stage.id,
					campId,
					freightDigest: d1,
					flowKind: "gitops-pull",
					flowTarget,
					previousRevision: null,
				}),
				Story.succeed(CdDeliveryFlow.publishRevision, {
					outcome: { _tag: "Committed", revision: rev1, targetRef },
				}),
				Story.then(
					r1,
					new DeliveryRevisionCommitted({ revision: rev1, targetRef }),
				),
				Story.call(CdDeliveryFlow.observeConvergence, {
					deliveryRunId: r1.id,
					stageId: stage.id,
					campId,
					flowKind: "gitops-pull",
					flowTarget,
					targetRevision: rev1,
					triggerSync: false,
				}),
				Story.succeed(CdDeliveryFlow.observeConvergence, {
					observation: {
						_tag: "Converged",
						appliedRevision: rev1,
						summary: NonEmptyReason.make("r1-healthy"),
					},
				}),
				Story.then(
					r1,
					new DeliveryConvergenceObserved({
						appliedRevision: rev1,
						outOfSyncCount: NonNegativeCount.make(0),
						summary: NonEmptyReason.make("r1-healthy"),
					}),
					new DeliveryRunVerified({
						passed: true,
						implicit: true,
						summary: NonEmptyReason.make("r1-healthy"),
						verifiedAtMs: clockMs,
					}),
					new DeliveryRunCompleted({
						stageId: stage.id,
						freightDigest: d1,
						appliedRevision: rev1,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("r1-healthy"),
					}),
				),
				Story.then(
					stage,
					new StageEnteredVerifying({
						deliveryRunId: r1.id,
						freightDigest: d1,
					}),
					new StagePromotionCompleted({
						deliveryRunId: r1.id,
						freightDigest: d1,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("r1-healthy"),
					}),
					new StagePromotionStarted({
						deliveryRunId: r3.id,
						freightDigest: d3,
						previousFreightDigest: d1,
						campId,
						deliveryFlow: "gitops-pull",
						flowTarget,
						requiresApproval: true,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.then(
					r3,
					new DeliveryRunStarted({
						stageId: stage.id,
						campId,
						freightDigest: d3,
						previousRevision: null,
						flowKind: "gitops-pull",
						flowTarget,
						requiresApproval: true,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.view(CdDeliveryRunStatusView, r3, {
					_tag: "PendingApproval",
					stageId: stage.id,
					campId,
					freightDigest: d3,
					flowKind: "gitops-pull",
					flowTarget,
				}),
				Story.when(
					r3,
					new ApproveDeliveryRun({ approver: ApproverId.make("ops") }),
				),
				Story.then(
					r3,
					new DeliveryRunApproved({
						approver: ApproverId.make("ops"),
						stageId: stage.id,
						campId,
						freightDigest: d3,
						previousRevision: null,
						flowKind: "gitops-pull",
						flowTarget,
						implicitHealthVerification: true,
						triggerPullSync: false,
						requestedAtMs: clockMs,
					}),
				),
				Story.call(CdDeliveryFlow.publishRevision, {
					deliveryRunId: r3.id,
					stageId: stage.id,
					campId,
					freightDigest: d3,
					flowKind: "gitops-pull",
					flowTarget,
					previousRevision: null,
				}),
				Story.succeed(CdDeliveryFlow.publishRevision, {
					outcome: { _tag: "Committed", revision: rev3, targetRef },
				}),
				Story.then(
					r3,
					new DeliveryRevisionCommitted({ revision: rev3, targetRef }),
				),
				Story.call(CdDeliveryFlow.observeConvergence, {
					deliveryRunId: r3.id,
					stageId: stage.id,
					campId,
					flowKind: "gitops-pull",
					flowTarget,
					targetRevision: rev3,
					triggerSync: false,
				}),
				Story.succeed(CdDeliveryFlow.observeConvergence, {
					observation: {
						_tag: "Converged",
						appliedRevision: rev3,
						summary: NonEmptyReason.make("r3-healthy"),
					},
				}),
				Story.then(
					r3,
					new DeliveryConvergenceObserved({
						appliedRevision: rev3,
						outOfSyncCount: NonNegativeCount.make(0),
						summary: NonEmptyReason.make("r3-healthy"),
					}),
					new DeliveryRunVerified({
						passed: true,
						implicit: true,
						summary: NonEmptyReason.make("r3-healthy"),
						verifiedAtMs: clockMs,
					}),
					new DeliveryRunCompleted({
						stageId: stage.id,
						freightDigest: d3,
						appliedRevision: rev3,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("r3-healthy"),
					}),
				),
				Story.then(
					stage,
					new StageEnteredVerifying({
						deliveryRunId: r3.id,
						freightDigest: d3,
					}),
					new StagePromotionCompleted({
						deliveryRunId: r3.id,
						freightDigest: d3,
						qualifiedAtMs: clockMs,
						summary: NonEmptyReason.make("r3-healthy"),
					}),
				),
				Story.when(
					stage,
					new ReverifyStageFreight({
						deliveryRunId: reverifyId,
						nowMs: clockMs,
					}),
				),
				Story.then(
					stage,
					new StageReverificationStarted({
						deliveryRunId: reverifyId,
						freightDigest: d3,
						campId,
						flowTarget,
						startedAtMs: clockMs,
					}),
				),
				Story.view(CdStageStatusView, stage, {
					_tag: "Verifying",
					config: stageConfig,
					activeRunId: reverifyId,
					activeFreightDigest: d3,
					currentFreightDigest: d3,
					currentVerified: true,
					lastVerifiedAtMs: clockMs,
					pending: null,
				}),
				Story.when(
					stage,
					new AbortStageVerification({
						reason: NonEmptyReason.make("operator-cancelled-reverify"),
					}),
				),
				Story.then(
					stage,
					new StageVerificationAborted({
						deliveryRunId: reverifyId,
						freightDigest: d3,
						reason: NonEmptyReason.make("operator-cancelled-reverify"),
					}),
				),
				Story.view(CdStageStatusView, stage, {
					_tag: "Idle",
					config: stageConfig,
					currentFreightDigest: d3,
					currentVerified: false,
					lastVerifiedAtMs: clockMs,
				}),
			),
		);
	});

	runDeliveryFlowConformance(
		"stateless-pull-stub",
		CdDeliveryFlow.toLayer(
			Effect.succeed({
				publishRevision: ({ deliveryRunId }) =>
					Effect.succeed({
						outcome: {
							_tag: "Committed" as const,
							revision: RevisionRef.make(`rev:${deliveryRunId}`),
							targetRef: NonEmptyReason.make("gitops:stub"),
						},
					}),
				observePullRequest: () =>
					Effect.succeed({
						observation: {
							_tag: "Merged" as const,
							mergeRevision: RevisionRef.make("rev:merged"),
							summary: NonEmptyReason.make("merged"),
						},
					}),
				observeConvergence: ({ targetRevision }) =>
					Effect.succeed({
						observation: {
							_tag: "Converged" as const,
							appliedRevision: targetRevision,
							summary: NonEmptyReason.make("healthy"),
						},
					}),
				rollbackRevision: ({ targetRevision }) =>
					Effect.succeed({
						rolledBack: true,
						rollbackRevision: RevisionRef.make(`revert:${targetRevision}`),
						summary: NonEmptyReason.make("rolled-back"),
					}),
			}),
		),
	);

	it("fails closed with ExternalSystemSchemaError when CdDeliveryFlow returns schema-drifting data", async () => {
		const DriftedFlow = CdDeliveryFlow.toLayer(
			Effect.succeed({
				publishRevision: () =>
					Effect.sync(() =>
						JSON.parse('{"outcome":{"_tag":"Committed","revision":""}}'),
					),
				observePullRequest: () =>
					Effect.sync(() =>
						JSON.parse('{"observation":{"_tag":"Open","summary":""}}'),
					),
				observeConvergence: () =>
					Effect.sync(() =>
						JSON.parse(
							'{"observation":{"_tag":"Converged","appliedRevision":""}}',
						),
					),
				rollbackRevision: () =>
					Effect.sync(() =>
						JSON.parse(
							'{"rolledBack":true,"rollbackRevision":null,"summary":""}',
						),
					),
			}),
		);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const flow = yield* CdDeliveryFlow;
				return yield* flow.publishRevision({
					deliveryRunId: DeliveryRunId.make("run-drift"),
					stageId: StageId.make("dev"),
					campId: CampTargetId.make("camp-drift"),
					freightDigest: FreightDigest.make("sha256:drift"),
					flowKind: "gitops-pull",
					flowTarget: DeliveryFlowTarget.make("gitops-engine"),
					previousRevision: null,
				});
			}).pipe(Effect.provide(DriftedFlow)),
		);

		expect(Exit.isFailure(exit)).toBe(true);
	});
});
