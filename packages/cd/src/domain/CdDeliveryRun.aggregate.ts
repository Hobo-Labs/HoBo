import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ApproverId,
	BranchName,
	CampTargetId,
	DeliveryFlowKind,
	DeliveryFlowTarget,
	DeliveryRunId,
	DeliveryRunPhase,
	EpochMs,
	FreightDigest,
	NonEmptyReason,
	NonNegativeCount,
	PullRequestId,
	PullRequestUrl,
	RevisionRef,
	StageId,
} from "./ids.js";

export class DeliveryRunAlreadyStarted extends Domain.Rejection(
	"DeliveryRunAlreadyStarted",
	{
		phase: DeliveryRunPhase,
	},
) {}

export class DeliveryRunNotPendingApproval extends Domain.Rejection(
	"DeliveryRunNotPendingApproval",
	{
		phase: DeliveryRunPhase,
	},
) {}

export class DeliveryRunAlreadyFinal extends Domain.Rejection(
	"DeliveryRunAlreadyFinal",
	{
		phase: DeliveryRunPhase,
	},
) {}

export class DeliveryRunInvalidTransition extends Domain.Rejection(
	"DeliveryRunInvalidTransition",
	{
		phase: DeliveryRunPhase,
		expected: DeliveryRunPhase,
	},
) {}

export class DeliveryRunStarted extends Domain.Event("DeliveryRunStarted", {
	stageId: StageId,
	campId: CampTargetId,
	freightDigest: FreightDigest,
	previousRevision: Schema.NullOr(RevisionRef),
	flowKind: DeliveryFlowKind,
	flowTarget: DeliveryFlowTarget,
	requiresApproval: Schema.Boolean,
	implicitHealthVerification: Schema.Boolean,
	triggerPullSync: Schema.Boolean,
	requestedAtMs: EpochMs,
}) {}

export class DeliveryRunApproved extends Domain.Event("DeliveryRunApproved", {
	approver: ApproverId,
	stageId: StageId,
	campId: CampTargetId,
	freightDigest: FreightDigest,
	previousRevision: Schema.NullOr(RevisionRef),
	flowKind: DeliveryFlowKind,
	flowTarget: DeliveryFlowTarget,
	implicitHealthVerification: Schema.Boolean,
	triggerPullSync: Schema.Boolean,
	requestedAtMs: EpochMs,
}) {}

export class DeliveryRevisionCommitted extends Domain.Event(
	"DeliveryRevisionCommitted",
	{
		revision: RevisionRef,
		targetRef: NonEmptyReason,
	},
) {}

export class DeliveryPullRequestOpened extends Domain.Event(
	"DeliveryPullRequestOpened",
	{
		revision: RevisionRef,
		prId: PullRequestId,
		prUrl: PullRequestUrl,
		headBranch: BranchName,
		targetRef: NonEmptyReason,
	},
) {}

export class DeliveryPullRequestMerged extends Domain.Event(
	"DeliveryPullRequestMerged",
	{
		prId: PullRequestId,
		mergeRevision: RevisionRef,
		summary: NonEmptyReason,
	},
) {}

export class DeliveryConvergenceObserved extends Domain.Event(
	"DeliveryConvergenceObserved",
	{
		appliedRevision: RevisionRef,
		outOfSyncCount: NonNegativeCount,
		summary: NonEmptyReason,
	},
) {}

export class DeliveryRunVerified extends Domain.Event("DeliveryRunVerified", {
	passed: Schema.Boolean,
	implicit: Schema.Boolean,
	summary: NonEmptyReason,
	verifiedAtMs: EpochMs,
}) {}

export class DeliveryRunCompleted extends Domain.Event("DeliveryRunCompleted", {
	stageId: StageId,
	freightDigest: FreightDigest,
	appliedRevision: RevisionRef,
	qualifiedAtMs: EpochMs,
	summary: NonEmptyReason,
}) {}

export class DeliveryRunRolledBack extends Domain.Event(
	"DeliveryRunRolledBack",
	{
		stageId: StageId,
		freightDigest: FreightDigest,
		rollbackRevision: Schema.NullOr(RevisionRef),
		reason: NonEmptyReason,
	},
) {}

export class DeliveryRunFailed extends Domain.Event("DeliveryRunFailed", {
	stageId: Schema.NullOr(StageId),
	freightDigest: Schema.NullOr(FreightDigest),
	reason: NonEmptyReason,
}) {}

export class StartDeliveryRun extends Domain.Command(
	"StartDeliveryRun",
	{
		target: DeliveryRunId,
		input: {
			stageId: StageId,
			campId: CampTargetId,
			freightDigest: FreightDigest,
			previousRevision: Schema.NullOr(RevisionRef),
			flowKind: DeliveryFlowKind,
			flowTarget: DeliveryFlowTarget,
			requiresApproval: Schema.Boolean,
			implicitHealthVerification: Schema.Boolean,
			triggerPullSync: Schema.Boolean,
			requestedAtMs: EpochMs,
		},
		events: [DeliveryRunStarted],
		rejects: [DeliveryRunAlreadyStarted],
	},
	{
		description:
			"Start a pluggable pull-based or direct CD delivery run for a Stage and Freight.",
	},
) {}

export class ApproveDeliveryRun extends Domain.Command(
	"ApproveDeliveryRun",
	{
		target: DeliveryRunId,
		input: {
			approver: ApproverId,
		},
		events: [DeliveryRunApproved],
		rejects: [DeliveryRunNotPendingApproval, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Approve a pending CD delivery run so its pluggable flow executes.",
	},
) {}

export class RecordDeliveryRevisionCommitted extends Domain.Command(
	"RecordDeliveryRevisionCommitted",
	{
		target: DeliveryRunId,
		input: {
			revision: RevisionRef,
			targetRef: NonEmptyReason,
		},
		events: [DeliveryRevisionCommitted],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Record a committed desired-state revision awaiting target pull convergence.",
	},
) {}

export class RecordDeliveryPullRequestOpened extends Domain.Command(
	"RecordDeliveryPullRequestOpened",
	{
		target: DeliveryRunId,
		input: {
			revision: RevisionRef,
			prId: PullRequestId,
			prUrl: PullRequestUrl,
			headBranch: BranchName,
			targetRef: NonEmptyReason,
		},
		events: [DeliveryPullRequestOpened],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Record an opened GitOps pull request awaiting merge before convergence.",
	},
) {}

export class RecordDeliveryPullRequestMerged extends Domain.Command(
	"RecordDeliveryPullRequestMerged",
	{
		target: DeliveryRunId,
		input: {
			prId: PullRequestId,
			mergeRevision: RevisionRef,
			summary: NonEmptyReason,
		},
		events: [DeliveryPullRequestMerged],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Record that the promotion pull request merged and advance to pull convergence.",
	},
) {}

export class RecordDeliveryConvergence extends Domain.Command(
	"RecordDeliveryConvergence",
	{
		target: DeliveryRunId,
		input: {
			appliedRevision: RevisionRef,
			outOfSyncCount: NonNegativeCount,
			summary: NonEmptyReason,
		},
		events: [DeliveryConvergenceObserved],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description: "Record pull-engine convergence on the exact target revision.",
	},
) {}

export class RecordDeliveryVerification extends Domain.Command(
	"RecordDeliveryVerification",
	{
		target: DeliveryRunId,
		input: {
			passed: Schema.Boolean,
			implicit: Schema.Boolean,
			summary: NonEmptyReason,
			verifiedAtMs: EpochMs,
		},
		events: [DeliveryRunVerified],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Record explicit or implicit health verification for a converged delivery run.",
	},
) {}

export class CompleteDeliveryRun extends Domain.Command(
	"CompleteDeliveryRun",
	{
		target: DeliveryRunId,
		input: {
			qualifiedAtMs: EpochMs,
		},
		events: [DeliveryRunCompleted],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Complete a verified delivery run and emit Stage qualification facts.",
	},
) {}

export class RollbackDeliveryRun extends Domain.Command(
	"RollbackDeliveryRun",
	{
		target: DeliveryRunId,
		input: {
			rollbackRevision: Schema.NullOr(RevisionRef),
			reason: NonEmptyReason,
		},
		events: [DeliveryRunRolledBack],
		rejects: [DeliveryRunInvalidTransition, DeliveryRunAlreadyFinal],
	},
	{
		description:
			"Record confirmed rollback compensation for a published delivery run.",
	},
) {}

export class FailDeliveryRun extends Domain.Command(
	"FailDeliveryRun",
	{
		target: DeliveryRunId,
		input: {
			reason: NonEmptyReason,
		},
		events: [DeliveryRunFailed],
		rejects: [],
	},
	{
		description:
			"Fail a delivery run after unrecoverable error, closed PR, or unconfirmed rollback.",
	},
) {}

const DeliveryRunContextFields = {
	stageId: StageId,
	campId: CampTargetId,
	freightDigest: FreightDigest,
	previousRevision: Schema.NullOr(RevisionRef),
	flowKind: DeliveryFlowKind,
	flowTarget: DeliveryFlowTarget,
	implicitHealthVerification: Schema.Boolean,
	triggerPullSync: Schema.Boolean,
	requestedAtMs: EpochMs,
};

export const CdDeliveryRunState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("PendingApproval", DeliveryRunContextFields),
	Schema.TaggedStruct("Publishing", {
		...DeliveryRunContextFields,
		approver: Schema.NullOr(ApproverId),
	}),
	Schema.TaggedStruct("AwaitingPullRequest", {
		...DeliveryRunContextFields,
		approver: Schema.NullOr(ApproverId),
		revision: RevisionRef,
		prId: PullRequestId,
		prUrl: PullRequestUrl,
		headBranch: BranchName,
		targetRef: NonEmptyReason,
	}),
	Schema.TaggedStruct("AwaitingConvergence", {
		...DeliveryRunContextFields,
		approver: Schema.NullOr(ApproverId),
		targetRevision: RevisionRef,
		prId: Schema.NullOr(PullRequestId),
	}),
	Schema.TaggedStruct("Verifying", {
		...DeliveryRunContextFields,
		approver: Schema.NullOr(ApproverId),
		appliedRevision: RevisionRef,
		prId: Schema.NullOr(PullRequestId),
		verificationPassed: Schema.Boolean,
		verificationSummary: Schema.NullOr(NonEmptyReason),
	}),
	Schema.TaggedStruct("Completed", {
		...DeliveryRunContextFields,
		approver: Schema.NullOr(ApproverId),
		appliedRevision: RevisionRef,
		prId: Schema.NullOr(PullRequestId),
		qualifiedAtMs: EpochMs,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("RolledBack", {
		...DeliveryRunContextFields,
		approver: Schema.NullOr(ApproverId),
		rollbackRevision: Schema.NullOr(RevisionRef),
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Failed", {
		stageId: Schema.NullOr(StageId),
		freightDigest: Schema.NullOr(FreightDigest),
		reason: NonEmptyReason,
	}),
]);
export type CdDeliveryRunState = typeof CdDeliveryRunState.Type;

function runPhaseOf(state: CdDeliveryRunState): DeliveryRunPhase {
	switch (state._tag) {
		case "Idle":
			return "idle";
		case "PendingApproval":
			return "pending-approval";
		case "Publishing":
			return "publishing";
		case "AwaitingPullRequest":
			return "awaiting-pr";
		case "AwaitingConvergence":
			return "awaiting-convergence";
		case "Verifying":
			return "verifying";
		case "Completed":
			return "completed";
		case "RolledBack":
			return "rolled-back";
		case "Failed":
			return "failed";
	}
}

function isRunFinal(state: CdDeliveryRunState): boolean {
	return (
		state._tag === "Completed" ||
		state._tag === "RolledBack" ||
		state._tag === "Failed"
	);
}

export class CdDeliveryRun extends Domain.Aggregate("CdDeliveryRun", {
	id: DeliveryRunId,
	state: CdDeliveryRunState,
	initial: { _tag: "Idle" },
	commands: [
		StartDeliveryRun,
		ApproveDeliveryRun,
		RecordDeliveryRevisionCommitted,
		RecordDeliveryPullRequestOpened,
		RecordDeliveryPullRequestMerged,
		RecordDeliveryConvergence,
		RecordDeliveryVerification,
		CompleteDeliveryRun,
		RollbackDeliveryRun,
		FailDeliveryRun,
	],
	decide: {
		StartDeliveryRun: (state, cmd) => {
			if (state._tag !== "Idle") {
				return new DeliveryRunAlreadyStarted({ phase: runPhaseOf(state) });
			}
			return [
				new DeliveryRunStarted({
					stageId: cmd.stageId,
					campId: cmd.campId,
					freightDigest: cmd.freightDigest,
					previousRevision: cmd.previousRevision,
					flowKind: cmd.flowKind,
					flowTarget: cmd.flowTarget,
					requiresApproval: cmd.requiresApproval,
					implicitHealthVerification: cmd.implicitHealthVerification,
					triggerPullSync: cmd.triggerPullSync,
					requestedAtMs: cmd.requestedAtMs,
				}),
			];
		},
		ApproveDeliveryRun: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "PendingApproval") {
				return new DeliveryRunNotPendingApproval({ phase: runPhaseOf(state) });
			}
			return [
				new DeliveryRunApproved({
					approver: cmd.approver,
					stageId: state.stageId,
					campId: state.campId,
					freightDigest: state.freightDigest,
					previousRevision: state.previousRevision,
					flowKind: state.flowKind,
					flowTarget: state.flowTarget,
					implicitHealthVerification: state.implicitHealthVerification,
					triggerPullSync: state.triggerPullSync,
					requestedAtMs: state.requestedAtMs,
				}),
			];
		},
		RecordDeliveryRevisionCommitted: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "Publishing") {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "publishing",
				});
			}
			return [
				new DeliveryRevisionCommitted({
					revision: cmd.revision,
					targetRef: cmd.targetRef,
				}),
			];
		},
		RecordDeliveryPullRequestOpened: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "Publishing") {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "publishing",
				});
			}
			return [
				new DeliveryPullRequestOpened({
					revision: cmd.revision,
					prId: cmd.prId,
					prUrl: cmd.prUrl,
					headBranch: cmd.headBranch,
					targetRef: cmd.targetRef,
				}),
			];
		},
		RecordDeliveryPullRequestMerged: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "AwaitingPullRequest") {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "awaiting-pr",
				});
			}
			return [
				new DeliveryPullRequestMerged({
					prId: cmd.prId,
					mergeRevision: cmd.mergeRevision,
					summary: cmd.summary,
				}),
			];
		},
		RecordDeliveryConvergence: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "AwaitingConvergence") {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "awaiting-convergence",
				});
			}
			return [
				new DeliveryConvergenceObserved({
					appliedRevision: cmd.appliedRevision,
					outOfSyncCount: cmd.outOfSyncCount,
					summary: cmd.summary,
				}),
			];
		},
		RecordDeliveryVerification: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "Verifying") {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "verifying",
				});
			}
			return [
				new DeliveryRunVerified({
					passed: cmd.passed,
					implicit: cmd.implicit,
					summary: cmd.summary,
					verifiedAtMs: cmd.verifiedAtMs,
				}),
			];
		},
		CompleteDeliveryRun: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (
				state._tag !== "Verifying" ||
				!state.verificationPassed ||
				state.verificationSummary === null
			) {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "verifying",
				});
			}
			return [
				new DeliveryRunCompleted({
					stageId: state.stageId,
					freightDigest: state.freightDigest,
					appliedRevision: state.appliedRevision,
					qualifiedAtMs: cmd.qualifiedAtMs,
					summary: state.verificationSummary,
				}),
			];
		},
		RollbackDeliveryRun: (state, cmd) => {
			if (isRunFinal(state)) {
				return new DeliveryRunAlreadyFinal({ phase: runPhaseOf(state) });
			}
			if (state._tag !== "AwaitingConvergence" && state._tag !== "Verifying") {
				return new DeliveryRunInvalidTransition({
					phase: runPhaseOf(state),
					expected: "awaiting-convergence",
				});
			}
			return [
				new DeliveryRunRolledBack({
					stageId: state.stageId,
					freightDigest: state.freightDigest,
					rollbackRevision: cmd.rollbackRevision,
					reason: cmd.reason,
				}),
			];
		},
		FailDeliveryRun: (state, cmd) =>
			isRunFinal(state)
				? []
				: [
						new DeliveryRunFailed({
							stageId: state._tag === "Idle" ? null : state.stageId,
							freightDigest: state._tag === "Idle" ? null : state.freightDigest,
							reason: cmd.reason,
						}),
					],
	},
	evolve: {
		DeliveryRunStarted: (_state, event) =>
			event.requiresApproval
				? {
						_tag: "PendingApproval" as const,
						stageId: event.stageId,
						campId: event.campId,
						freightDigest: event.freightDigest,
						previousRevision: event.previousRevision,
						flowKind: event.flowKind,
						flowTarget: event.flowTarget,
						implicitHealthVerification: event.implicitHealthVerification,
						triggerPullSync: event.triggerPullSync,
						requestedAtMs: event.requestedAtMs,
					}
				: {
						_tag: "Publishing" as const,
						stageId: event.stageId,
						campId: event.campId,
						freightDigest: event.freightDigest,
						previousRevision: event.previousRevision,
						flowKind: event.flowKind,
						flowTarget: event.flowTarget,
						implicitHealthVerification: event.implicitHealthVerification,
						triggerPullSync: event.triggerPullSync,
						requestedAtMs: event.requestedAtMs,
						approver: null,
					},
		DeliveryRunApproved: (_state, event) => ({
			_tag: "Publishing" as const,
			stageId: event.stageId,
			campId: event.campId,
			freightDigest: event.freightDigest,
			previousRevision: event.previousRevision,
			flowKind: event.flowKind,
			flowTarget: event.flowTarget,
			implicitHealthVerification: event.implicitHealthVerification,
			triggerPullSync: event.triggerPullSync,
			requestedAtMs: event.requestedAtMs,
			approver: event.approver,
		}),
		DeliveryRevisionCommitted: (state, event) =>
			state._tag === "Publishing"
				? {
						_tag: "AwaitingConvergence" as const,
						stageId: state.stageId,
						campId: state.campId,
						freightDigest: state.freightDigest,
						previousRevision: state.previousRevision,
						flowKind: state.flowKind,
						flowTarget: state.flowTarget,
						implicitHealthVerification: state.implicitHealthVerification,
						triggerPullSync: state.triggerPullSync,
						requestedAtMs: state.requestedAtMs,
						approver: state.approver,
						targetRevision: event.revision,
						prId: null,
					}
				: state,
		DeliveryPullRequestOpened: (state, event) =>
			state._tag === "Publishing"
				? {
						_tag: "AwaitingPullRequest" as const,
						stageId: state.stageId,
						campId: state.campId,
						freightDigest: state.freightDigest,
						previousRevision: state.previousRevision,
						flowKind: state.flowKind,
						flowTarget: state.flowTarget,
						implicitHealthVerification: state.implicitHealthVerification,
						triggerPullSync: state.triggerPullSync,
						requestedAtMs: state.requestedAtMs,
						approver: state.approver,
						revision: event.revision,
						prId: event.prId,
						prUrl: event.prUrl,
						headBranch: event.headBranch,
						targetRef: event.targetRef,
					}
				: state,
		DeliveryPullRequestMerged: (state, event) =>
			state._tag === "AwaitingPullRequest"
				? {
						_tag: "AwaitingConvergence" as const,
						stageId: state.stageId,
						campId: state.campId,
						freightDigest: state.freightDigest,
						previousRevision: state.previousRevision,
						flowKind: state.flowKind,
						flowTarget: state.flowTarget,
						implicitHealthVerification: state.implicitHealthVerification,
						triggerPullSync: state.triggerPullSync,
						requestedAtMs: state.requestedAtMs,
						approver: state.approver,
						targetRevision: event.mergeRevision,
						prId: event.prId,
					}
				: state,
		DeliveryConvergenceObserved: (state, event) =>
			state._tag === "AwaitingConvergence"
				? {
						_tag: "Verifying" as const,
						stageId: state.stageId,
						campId: state.campId,
						freightDigest: state.freightDigest,
						previousRevision: state.previousRevision,
						flowKind: state.flowKind,
						flowTarget: state.flowTarget,
						implicitHealthVerification: state.implicitHealthVerification,
						triggerPullSync: state.triggerPullSync,
						requestedAtMs: state.requestedAtMs,
						approver: state.approver,
						appliedRevision: event.appliedRevision,
						prId: state.prId,
						verificationPassed: false,
						verificationSummary: null,
					}
				: state,
		DeliveryRunVerified: (state, event) =>
			state._tag === "Verifying"
				? {
						...state,
						verificationPassed: event.passed,
						verificationSummary: event.summary,
					}
				: state,
		DeliveryRunCompleted: (state, event) =>
			state._tag === "Verifying"
				? {
						_tag: "Completed" as const,
						stageId: state.stageId,
						campId: state.campId,
						freightDigest: state.freightDigest,
						previousRevision: state.previousRevision,
						flowKind: state.flowKind,
						flowTarget: state.flowTarget,
						implicitHealthVerification: state.implicitHealthVerification,
						triggerPullSync: state.triggerPullSync,
						requestedAtMs: state.requestedAtMs,
						approver: state.approver,
						appliedRevision: event.appliedRevision,
						prId: state.prId,
						qualifiedAtMs: event.qualifiedAtMs,
						summary: event.summary,
					}
				: state,
		DeliveryRunRolledBack: (state, event) =>
			state._tag === "AwaitingConvergence" || state._tag === "Verifying"
				? {
						_tag: "RolledBack" as const,
						stageId: state.stageId,
						campId: state.campId,
						freightDigest: state.freightDigest,
						previousRevision: state.previousRevision,
						flowKind: state.flowKind,
						flowTarget: state.flowTarget,
						implicitHealthVerification: state.implicitHealthVerification,
						triggerPullSync: state.triggerPullSync,
						requestedAtMs: state.requestedAtMs,
						approver: state.approver,
						rollbackRevision: event.rollbackRevision,
						reason: event.reason,
					}
				: state,
		DeliveryRunFailed: (_state, event) => ({
			_tag: "Failed" as const,
			stageId: event.stageId,
			freightDigest: event.freightDigest,
			reason: event.reason,
		}),
	},
}) {}
