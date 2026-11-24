import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import {
	CampTargetId,
	CdPromotionId,
	CdPromotionPhase,
	FreightDigest,
} from "./ids.js";

export class PromotionAlreadyStarted extends Domain.Rejection(
	"PromotionAlreadyStarted",
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

export class VerificationRequiredBeforeComplete extends Domain.Rejection(
	"VerificationRequiredBeforeComplete",
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
	approver: Schema.String,
	campId: CampTargetId,
	freightDigest: FreightDigest,
}) {}

export class CdPromotionRealized extends Domain.Event("CdPromotionRealized", {
	realizationRef: Schema.String,
}) {}

export class CdPromotionVerified extends Domain.Event("CdPromotionVerified", {
	passed: Schema.Boolean,
	summary: Schema.String,
}) {}

export class CdPromotionCompleted extends Domain.Event("CdPromotionCompleted", {
	realizationRef: Schema.String,
}) {}

export class CdPromotionRolledBack extends Domain.Event(
	"CdPromotionRolledBack",
	{
		reason: Schema.String,
	},
) {}

export class CdPromotionFailed extends Domain.Event("CdPromotionFailed", {
	reason: Schema.String,
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
	{ description: "Start a CD promotion lifecycle for a camp and freight digest." },
) {}

export class ApproveCdPromotion extends Domain.Command(
	"ApproveCdPromotion",
	{
		target: CdPromotionId,
		input: {
			approver: Schema.String,
		},
		events: [CdPromotionApproved],
		rejects: [PromotionAlreadyFinal],
	},
	{ description: "Record an operator approval for a pending CD promotion." },
) {}

export class RecordCdRealization extends Domain.Command(
	"RecordCdRealization",
	{
		target: CdPromotionId,
		input: {
			realizationRef: Schema.String,
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
			summary: Schema.String,
		},
		events: [CdPromotionVerified],
		rejects: [PromotionAlreadyFinal],
	},
	{ description: "Record verification gate evaluation for a realized promotion." },
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
			reason: Schema.String,
		},
		events: [CdPromotionRolledBack],
		rejects: [PromotionAlreadyFinal],
	},
	{ description: "Record rollback compensation for an unverified promotion." },
) {}

export class FailCdPromotion extends Domain.Command(
	"FailCdPromotion",
	{
		target: CdPromotionId,
		input: {
			reason: Schema.String,
		},
		events: [CdPromotionFailed],
		rejects: [],
	},
	{ description: "Mark a promotion as failed after unrecoverable error." },
) {}

const CdPromotionState = Schema.Struct({
	phase: CdPromotionPhase,
	campId: Schema.NullOr(CampTargetId),
	freightDigest: Schema.NullOr(FreightDigest),
	requiresApproval: Schema.Boolean,
	approver: Schema.NullOr(Schema.String),
	realizationRef: Schema.NullOr(Schema.String),
	verificationPassed: Schema.Boolean,
	failureReason: Schema.NullOr(Schema.String),
});

function isFinalPhase(phase: CdPromotionPhase): boolean {
	return phase === "completed" || phase === "rolled-back" || phase === "failed";
}

export class CdPromotion extends Domain.Aggregate("CdPromotion", {
	id: CdPromotionId,
	state: CdPromotionState,
	initial: {
		phase: "idle" as const,
		campId: null,
		freightDigest: null,
		requiresApproval: false,
		approver: null,
		realizationRef: null,
		verificationPassed: false,
		failureReason: null,
	},
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
			if (state.phase !== "idle") {
				return new PromotionAlreadyStarted({ phase: state.phase });
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
			if (isFinalPhase(state.phase)) {
				return new PromotionAlreadyFinal({ phase: state.phase });
			}
			if (state.campId === null || state.freightDigest === null) {
				return new PromotionAlreadyFinal({ phase: state.phase });
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
			if (isFinalPhase(state.phase)) {
				return new PromotionAlreadyFinal({ phase: state.phase });
			}
			if (state.requiresApproval && state.approver === null) {
				return new ApprovalRequiredBeforeRealize({ phase: state.phase });
			}
			return [new CdPromotionRealized({ realizationRef: cmd.realizationRef })];
		},
		RecordCdVerification: (state, cmd) => {
			if (isFinalPhase(state.phase)) {
				return new PromotionAlreadyFinal({ phase: state.phase });
			}
			return [
				new CdPromotionVerified({
					passed: cmd.passed,
					summary: cmd.summary,
				}),
			];
		},
		CompleteCdPromotion: (state) => {
			if (isFinalPhase(state.phase)) {
				return new PromotionAlreadyFinal({ phase: state.phase });
			}
			if (!state.verificationPassed || state.realizationRef === null) {
				return new VerificationRequiredBeforeComplete({ phase: state.phase });
			}
			return [
				new CdPromotionCompleted({ realizationRef: state.realizationRef }),
			];
		},
		RollbackCdPromotion: (state, cmd) => {
			if (isFinalPhase(state.phase)) {
				return new PromotionAlreadyFinal({ phase: state.phase });
			}
			return [new CdPromotionRolledBack({ reason: cmd.reason })];
		},
		FailCdPromotion: (_state, cmd) => [
			new CdPromotionFailed({ reason: cmd.reason }),
		],
	},
	evolve: {
		CdPromotionRequested: (state, event) => ({
			...state,
			phase: event.requiresApproval
				? ("pending-approval" as const)
				: ("approved" as const),
			campId: event.campId,
			freightDigest: event.freightDigest,
			requiresApproval: event.requiresApproval,
		}),
		CdPromotionApproved: (state, event) => ({
			...state,
			phase: "approved" as const,
			approver: event.approver,
		}),
		CdPromotionRealized: (state, event) => ({
			...state,
			phase: "realized" as const,
			realizationRef: event.realizationRef,
		}),
		CdPromotionVerified: (state, event) => ({
			...state,
			phase: event.passed ? ("verified" as const) : state.phase,
			verificationPassed: event.passed,
		}),
		CdPromotionCompleted: (state) => ({
			...state,
			phase: "completed" as const,
		}),
		CdPromotionRolledBack: (state, event) => ({
			...state,
			phase: "rolled-back" as const,
			failureReason: event.reason,
		}),
		CdPromotionFailed: (state, event) => ({
			...state,
			phase: "failed" as const,
			failureReason: event.reason,
		}),
	},
}) {}
