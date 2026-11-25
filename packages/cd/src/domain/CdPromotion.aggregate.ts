import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	ApproverId,
	CampTargetId,
	CdPromotionId,
	CdPromotionPhase,
	FreightDigest,
	NonEmptyReason,
	RealizationRef,
} from "./ids.js";

export class PromotionAlreadyStarted extends Domain.Rejection(
	"PromotionAlreadyStarted",
	{
		phase: CdPromotionPhase,
	},
) {}

export class PromotionNotPendingApproval extends Domain.Rejection(
	"PromotionNotPendingApproval",
	{
		phase: CdPromotionPhase,
	},
) {}

export class PromotionAlreadyFinal extends Domain.Rejection(
	"PromotionAlreadyFinal",
	{
		phase: CdPromotionPhase,
	},
) {}

export class ApprovalRequiredBeforeRealize extends Domain.Rejection(
	"ApprovalRequiredBeforeRealize",
	{
		phase: CdPromotionPhase,
	},
) {}

export class RealizationRequiredBeforeVerify extends Domain.Rejection(
	"RealizationRequiredBeforeVerify",
	{
		phase: CdPromotionPhase,
	},
) {}

export class VerificationRequiredBeforeComplete extends Domain.Rejection(
	"VerificationRequiredBeforeComplete",
	{
		phase: CdPromotionPhase,
	},
) {}

export class RollbackRequiresRealization extends Domain.Rejection(
	"RollbackRequiresRealization",
	{
		phase: CdPromotionPhase,
	},
) {}

export class CdPromotionRequested extends Domain.Event("CdPromotionRequested", {
	campId: CampTargetId,
	freightDigest: FreightDigest,
	requiresApproval: Schema.Boolean,
}) {}

export class CdPromotionApproved extends Domain.Event("CdPromotionApproved", {
	approver: ApproverId,
	campId: CampTargetId,
	freightDigest: FreightDigest,
}) {}

export class CdPromotionRealized extends Domain.Event("CdPromotionRealized", {
	realizationRef: RealizationRef,
}) {}

export class CdPromotionVerified extends Domain.Event("CdPromotionVerified", {
	passed: Schema.Boolean,
	summary: NonEmptyReason,
}) {}

export class CdPromotionCompleted extends Domain.Event("CdPromotionCompleted", {
	realizationRef: RealizationRef,
}) {}

export class CdPromotionRolledBack extends Domain.Event(
	"CdPromotionRolledBack",
	{
		reason: NonEmptyReason,
	},
) {}

export class CdPromotionFailed extends Domain.Event("CdPromotionFailed", {
	reason: NonEmptyReason,
}) {}

export class RequestCdPromotion extends Domain.Command(
	"RequestCdPromotion",
	{
		target: CdPromotionId,
		input: {
			campId: CampTargetId,
			freightDigest: FreightDigest,
			requiresApproval: Schema.Boolean,
		},
		events: [CdPromotionRequested],
		rejects: [PromotionAlreadyStarted],
	},
	{
		description:
			"Start a CD promotion lifecycle for a camp and freight digest.",
	},
) {}

export class ApproveCdPromotion extends Domain.Command(
	"ApproveCdPromotion",
	{
		target: CdPromotionId,
		input: {
			approver: ApproverId,
		},
		events: [CdPromotionApproved],
		rejects: [PromotionNotPendingApproval, PromotionAlreadyFinal],
	},
	{ description: "Record an operator approval for a pending CD promotion." },
) {}

export class RecordCdRealization extends Domain.Command(
	"RecordCdRealization",
	{
		target: CdPromotionId,
		input: {
			realizationRef: RealizationRef,
		},
		events: [CdPromotionRealized],
		rejects: [ApprovalRequiredBeforeRealize, PromotionAlreadyFinal],
	},
	{ description: "Record successful camp realization for a promotion." },
) {}

export class RecordCdVerification extends Domain.Command(
	"RecordCdVerification",
	{
		target: CdPromotionId,
		input: {
			passed: Schema.Boolean,
			summary: NonEmptyReason,
		},
		events: [CdPromotionVerified],
		rejects: [RealizationRequiredBeforeVerify, PromotionAlreadyFinal],
	},
	{
		description:
			"Record verification gate evaluation for a realized promotion.",
	},
) {}

export class CompleteCdPromotion extends Domain.Command(
	"CompleteCdPromotion",
	{
		target: CdPromotionId,
		input: {},
		events: [CdPromotionCompleted],
		rejects: [VerificationRequiredBeforeComplete, PromotionAlreadyFinal],
	},
	{ description: "Mark a verified CD promotion as completed." },
) {}

export class RollbackCdPromotion extends Domain.Command(
	"RollbackCdPromotion",
	{
		target: CdPromotionId,
		input: {
			reason: NonEmptyReason,
		},
		events: [CdPromotionRolledBack],
		rejects: [RollbackRequiresRealization, PromotionAlreadyFinal],
	},
	{ description: "Record rollback compensation for an unverified promotion." },
) {}

export class FailCdPromotion extends Domain.Command(
	"FailCdPromotion",
	{
		target: CdPromotionId,
		input: {
			reason: NonEmptyReason,
		},
		events: [CdPromotionFailed],
		rejects: [],
	},
	{ description: "Mark a promotion as failed after unrecoverable error." },
) {}

export const CdPromotionState = Schema.Union([
	Schema.TaggedStruct("Idle", {}),
	Schema.TaggedStruct("PendingApproval", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
	}),
	Schema.TaggedStruct("Approved", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
	}),
	Schema.TaggedStruct("Realized", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
	}),
	Schema.TaggedStruct("Verified", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
		summary: NonEmptyReason,
	}),
	Schema.TaggedStruct("Completed", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
	}),
	Schema.TaggedStruct("RolledBack", {
		campId: CampTargetId,
		freightDigest: FreightDigest,
		approver: Schema.NullOr(ApproverId),
		realizationRef: RealizationRef,
		reason: NonEmptyReason,
	}),
	Schema.TaggedStruct("Failed", {
		campId: Schema.NullOr(CampTargetId),
		freightDigest: Schema.NullOr(FreightDigest),
		approver: Schema.NullOr(ApproverId),
		realizationRef: Schema.NullOr(RealizationRef),
		reason: NonEmptyReason,
	}),
]);
export type CdPromotionState = typeof CdPromotionState.Type;

function phaseOf(state: CdPromotionState): CdPromotionPhase {
	switch (state._tag) {
		case "Idle":
			return "idle";
		case "PendingApproval":
			return "pending-approval";
		case "Approved":
			return "approved";
		case "Realized":
			return "realized";
		case "Verified":
			return "verified";
		case "Completed":
			return "completed";
		case "RolledBack":
			return "rolled-back";
		case "Failed":
			return "failed";
	}
}

function isFinalState(state: CdPromotionState): boolean {
	return (
		state._tag === "Completed" ||
		state._tag === "RolledBack" ||
		state._tag === "Failed"
	);
}

export class CdPromotion extends Domain.Aggregate("CdPromotion", {
	id: CdPromotionId,
	state: CdPromotionState,
	initial: { _tag: "Idle" },
	commands: [
		RequestCdPromotion,
		ApproveCdPromotion,
		RecordCdRealization,
		RecordCdVerification,
		CompleteCdPromotion,
		RollbackCdPromotion,
		FailCdPromotion,
	],
	decide: {
		RequestCdPromotion: (state, cmd) => {
			if (state._tag !== "Idle") {
				return new PromotionAlreadyStarted({ phase: phaseOf(state) });
			}
			return [
				new CdPromotionRequested({
					campId: cmd.campId,
					freightDigest: cmd.freightDigest,
					requiresApproval: cmd.requiresApproval,
				}),
			];
		},
		ApproveCdPromotion: (state, cmd) => {
			if (isFinalState(state)) {
				return new PromotionAlreadyFinal({ phase: phaseOf(state) });
			}
			if (state._tag !== "PendingApproval") {
				return new PromotionNotPendingApproval({ phase: phaseOf(state) });
			}
			return [
				new CdPromotionApproved({
					approver: cmd.approver,
					campId: state.campId,
					freightDigest: state.freightDigest,
				}),
			];
		},
		RecordCdRealization: (state, cmd) => {
			if (isFinalState(state)) {
				return new PromotionAlreadyFinal({ phase: phaseOf(state) });
			}
			if (state._tag !== "Approved") {
				return new ApprovalRequiredBeforeRealize({ phase: phaseOf(state) });
			}
			return [new CdPromotionRealized({ realizationRef: cmd.realizationRef })];
		},
		RecordCdVerification: (state, cmd) => {
			if (isFinalState(state)) {
				return new PromotionAlreadyFinal({ phase: phaseOf(state) });
			}
			if (state._tag !== "Realized") {
				return new RealizationRequiredBeforeVerify({ phase: phaseOf(state) });
			}
			return [
				new CdPromotionVerified({
					passed: cmd.passed,
					summary: cmd.summary,
				}),
			];
		},
		CompleteCdPromotion: (state) => {
			if (isFinalState(state)) {
				return new PromotionAlreadyFinal({ phase: phaseOf(state) });
			}
			if (state._tag !== "Verified") {
				return new VerificationRequiredBeforeComplete({
					phase: phaseOf(state),
				});
			}
			return [
				new CdPromotionCompleted({ realizationRef: state.realizationRef }),
			];
		},
		RollbackCdPromotion: (state, cmd) => {
			if (isFinalState(state)) {
				return new PromotionAlreadyFinal({ phase: phaseOf(state) });
			}
			if (state._tag !== "Realized" && state._tag !== "Verified") {
				return new RollbackRequiresRealization({ phase: phaseOf(state) });
			}
			return [new CdPromotionRolledBack({ reason: cmd.reason })];
		},
		FailCdPromotion: (state, cmd) =>
			isFinalState(state)
				? []
				: [new CdPromotionFailed({ reason: cmd.reason })],
	},
	evolve: {
		CdPromotionRequested: (_state, event) =>
			event.requiresApproval
				? {
						_tag: "PendingApproval" as const,
						campId: event.campId,
						freightDigest: event.freightDigest,
					}
				: {
						_tag: "Approved" as const,
						campId: event.campId,
						freightDigest: event.freightDigest,
						approver: null,
					},
		CdPromotionApproved: (_state, event) => ({
			_tag: "Approved" as const,
			campId: event.campId,
			freightDigest: event.freightDigest,
			approver: event.approver,
		}),
		CdPromotionRealized: (state, event) =>
			state._tag === "Approved"
				? {
						_tag: "Realized" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: state.approver,
						realizationRef: event.realizationRef,
					}
				: state,
		CdPromotionVerified: (state, event) =>
			state._tag === "Realized" && event.passed
				? {
						_tag: "Verified" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: state.approver,
						realizationRef: state.realizationRef,
						summary: event.summary,
					}
				: state,
		CdPromotionCompleted: (state, event) =>
			state._tag === "Verified"
				? {
						_tag: "Completed" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: state.approver,
						realizationRef: event.realizationRef,
					}
				: state,
		CdPromotionRolledBack: (state, event) =>
			state._tag === "Realized" || state._tag === "Verified"
				? {
						_tag: "RolledBack" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: state.approver,
						realizationRef: state.realizationRef,
						reason: event.reason,
					}
				: state,
		CdPromotionFailed: (state, event) => {
			switch (state._tag) {
				case "Idle":
					return {
						_tag: "Failed" as const,
						campId: null,
						freightDigest: null,
						approver: null,
						realizationRef: null,
						reason: event.reason,
					};
				case "PendingApproval":
					return {
						_tag: "Failed" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: null,
						realizationRef: null,
						reason: event.reason,
					};
				case "Approved":
					return {
						_tag: "Failed" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: state.approver,
						realizationRef: null,
						reason: event.reason,
					};
				case "Realized":
				case "Verified":
				case "Completed":
				case "RolledBack":
				case "Failed":
					return {
						_tag: "Failed" as const,
						campId: state.campId,
						freightDigest: state.freightDigest,
						approver: state.approver,
						realizationRef: state.realizationRef,
						reason: event.reason,
					};
			}
		},
	},
}) {}
