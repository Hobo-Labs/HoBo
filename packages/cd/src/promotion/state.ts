// The promotion saga's write-model fold. One stream per promotion
// (`cd-promotion-<id>`) holds the request, the per-Camp saga steps (as
// `@hobo/events` saga facts) and the terminal outcomes; this module is the
// only reader that turns those facts into a PromotionView.
import { create } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import {
	createSagaStepEmittedEvent,
	createSagaCompensatedEvent,
	createSagaCompletedEvent,
	createSagaStartedEvent,
} from "@hobo/events";
import {
	type PreviewEnvironmentRecord,
	PreviewEnvironmentRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import type { DeltaIntent } from "../ports.js";
import { decode, isJsonObject, isText, msOf } from "./journal.js";

// public-contract: saga fact types the promotion saga appends to
// `cd-promotion-<id>`; owned by `@hobo/events` (no new CD event family).
export const SAGA_FACT = Object.freeze({
	started: "saga.Started",
	stepEmitted: "saga.StepEmitted",
	compensated: "saga.Compensated",
	completed: "saga.Completed",
} as const);

// public-contract: the saga name stamped on every promotion saga fact.
export const PROMOTION_SAGA = "cd.promotion" as const;

// public-contract: per-Camp saga steps in forward order. `step` in a
// `saga.StepEmitted` body is `<campId>|<step>`; `emittedType` carries the
// step's handle (Delta id, gate decision, approval request, Set id, rollout
// id, verification id, migration id) or the CD event the step emitted.
export const STEP = Object.freeze({
	resolved: "resolved",
	gated: "gated",
	awaitingWindow: "awaiting-window",
	approvalRequested: "approval-requested",
	approved: "approved",
	approvalDenied: "approval-denied",
	beforeApply: "before-apply",
	expanded: "expanded",
	applied: "applied",
	rollout: "rollout",
	converged: "converged",
	afterConverged: "after-converged",
	verification: "verification",
	qualified: "qualified",
	afterQualified: "after-qualified",
	contracted: "contracted",
	failed: "failed",
	compensated: "compensated",
} as const);

export type StepName = (typeof STEP)[keyof typeof STEP];

const STEP_NAMES: ReadonlySet<string> = new Set(Object.values(STEP));

function isStepName(value: string): value is StepName {
	return STEP_NAMES.has(value);
}

export type StepFact = Readonly<{ handle: string; atMs: number }>;

export type CampTerminal =
	| "promoted"
	| "rejected"
	| "failed"
	| "superseded"
	| "compensated";

export type CampProgress = {
	readonly campId: string;
	readonly steps: Map<StepName, StepFact>;
	terminal: CampTerminal | undefined;
	promotedAtMs: number | undefined;
	reasons: ReasonRecord[];
};

export type PromotionView = {
	readonly promotionId: string;
	request: PromotionRecord;
	requestedAtMs: number;
	readonly camps: Map<string, CampProgress>;
	rolledBack: PromotionRecord | undefined;
	preview: PreviewEnvironmentRecord | undefined;
	previewExpired: boolean;
	sagaCompleted: boolean;
	gateDecisionId: string;
	intent: DeltaIntent;
};

export function sagaIdOf(promotionId: string): string {
	return `${PROMOTION_SAGA}:${promotionId}`;
}

export function stepFact(
	promotionId: string,
	campId: string,
	step: StepName,
	handle: string,
) {
	return createSagaStepEmittedEvent({
		sagaId: sagaIdOf(promotionId),
		step: `${campId}|${step}`,
		emittedType: handle,
	});
}

const INTENTS: ReadonlySet<string> = new Set<DeltaIntent>([
	"promote",
	"rollback",
	"drift-remediate",
	"up",
	"down",
	"preview",
	"config",
	"topology",
	"failover",
	"depart",
	"posture-remediate",
]);

function isIntent(value: string): value is DeltaIntent {
	return INTENTS.has(value);
}

/** `saga.Started` names the saga and the Delta intent: `cd.promotion/<intent>`. */
export function startedFact(promotionId: string, intent: DeltaIntent) {
	return createSagaStartedEvent({
		sagaId: sagaIdOf(promotionId),
		name: `${PROMOTION_SAGA}/${intent}`,
		triggerType: CD_EVENTS.EnvPromoteRequested,
	});
}

function intentOfSagaName(data: unknown): DeltaIntent {
	if (!isJsonObject(data) || !isText(data.name)) return "promote";
	const name = String(data.name);
	const intent = name.startsWith(`${PROMOTION_SAGA}/`)
		? name.slice(PROMOTION_SAGA.length + 1)
		: "";
	return isIntent(intent) ? intent : "promote";
}

export function compensatedFact(
	promotionId: string,
	step: string,
	why: string,
) {
	return createSagaCompensatedEvent({
		sagaId: sagaIdOf(promotionId),
		step,
		reason: why,
	});
}

export function completedFact(promotionId: string, outcome: string) {
	return createSagaCompletedEvent({ sagaId: sagaIdOf(promotionId), outcome });
}

/** Parse a saga step body; undefined when it is not a promotion step. */
export function parseStep(
	promotionId: string,
	data: unknown,
): Readonly<{ campId: string; step: StepName; handle: string }> | undefined {
	if (!isJsonObject(data)) return undefined;
	if (data.sagaId !== sagaIdOf(promotionId)) return undefined;
	const step = isText(data.step) ? String(data.step) : undefined;
	const handle = isText(data.emittedType) ? String(data.emittedType) : undefined;
	if (step === undefined || handle === undefined) return undefined;
	const bar = step.lastIndexOf("|");
	if (bar <= 0) return undefined;
	const name = step.slice(bar + 1);
	if (!isStepName(name)) return undefined;
	return { campId: step.slice(0, bar), step: name, handle };
}

function progressOf(view: PromotionView, campId: string): CampProgress {
	const existing = view.camps.get(campId);
	if (existing) return existing;
	const fresh: CampProgress = {
		campId,
		steps: new Map(),
		terminal: undefined,
		promotedAtMs: undefined,
		reasons: [],
	};
	view.camps.set(campId, fresh);
	return fresh;
}

function terminalOf(record: PromotionRecord): CampTerminal | undefined {
	switch (record.state) {
		case PromotionState.REJECTED:
			return "rejected";
		case PromotionState.FAILED:
			return "failed";
		case PromotionState.SUPERSEDED:
			return "superseded";
		case PromotionState.ROLLED_BACK:
			return "compensated";
		default:
			return undefined;
	}
}

/** Fold one promotion stream. Undefined when it holds no readable request. */
export function foldPromotion(
	promotionId: string,
	events: readonly EventEnvelope[],
): PromotionView | undefined {
	let view: PromotionView | undefined;
	for (const event of events) {
		const atMs = msOf(event.ts) ?? 0;
		if (event.type === CD_EVENTS.EnvPromoteRequested) {
			const request = decode(PromotionRecordSchema, event.data);
			if (!request || request.promotionId !== promotionId || view) continue;
			view = {
				promotionId,
				request,
				requestedAtMs: atMs,
				camps: new Map(),
				rolledBack: undefined,
				preview: undefined,
				previewExpired: false,
				sagaCompleted: false,
				gateDecisionId: "",
				intent: "promote",
			};
			for (const campId of request.targetCampIds) progressOf(view, campId);
			continue;
		}
		if (event.type === CD_EVENTS.EnvPromoteRolledBack) {
			const record = decode(PromotionRecordSchema, event.data);
			if (!record) continue;
			if (!view) {
				view = {
					promotionId,
					request: record,
					requestedAtMs: atMs,
					camps: new Map(),
					rolledBack: record,
					preview: undefined,
					previewExpired: false,
					sagaCompleted: true,
					gateDecisionId: record.gateDecisionId,
					intent: "rollback",
				};
			} else view.rolledBack = record;
			continue;
		}
		if (event.type === CD_EVENTS.EnvCloned || event.type === CD_EVENTS.EnvExpired) {
			const record = decode(PreviewEnvironmentRecordSchema, event.data);
			// The preview fact always follows the request it belongs to.
			if (!record || !view) continue;
			view.preview = record;
			if (event.type === CD_EVENTS.EnvExpired) view.previewExpired = true;
			continue;
		}
		if (!view) continue;
		if (event.type === SAGA_FACT.stepEmitted) {
			const step = parseStep(promotionId, event.data);
			// Steps of other scopes (e.g. rollout-stage approvals) are not Camp progress.
			if (!step || !view.camps.has(step.campId)) continue;
			const progress = progressOf(view, step.campId);
			if (!progress.steps.has(step.step))
				progress.steps.set(step.step, { handle: step.handle, atMs });
			if (step.step === STEP.gated) view.gateDecisionId = handleId(step.handle);
			if (step.step === STEP.compensated && progress.terminal === undefined)
				progress.terminal = "compensated";
			continue;
		}
		if (event.type === SAGA_FACT.started) {
			view.intent = intentOfSagaName(event.data);
			continue;
		}
		if (event.type === SAGA_FACT.completed) {
			view.sagaCompleted = true;
			continue;
		}
		const record =
			event.type === CD_EVENTS.EnvPromoted ||
			event.type === CD_EVENTS.EnvPromoteRejected ||
			event.type === CD_EVENTS.EnvPromoteSuperseded
				? decode(PromotionRecordSchema, event.data)
				: undefined;
		if (!record) continue;
		for (const campId of record.targetCampIds) {
			const progress = progressOf(view, campId);
			if (progress.terminal !== undefined && progress.terminal !== "promoted")
				continue;
			if (event.type === CD_EVENTS.EnvPromoted) {
				progress.terminal = "promoted";
				progress.promotedAtMs ??= atMs;
			} else {
				progress.terminal =
					event.type === CD_EVENTS.EnvPromoteSuperseded
						? "superseded"
						: (terminalOf(record) ?? "rejected");
				progress.reasons = [...record.reasons];
			}
		}
	}
	return view;
}

/** The id part of a `<effect> <decisionId>` gate handle. */
export function handleId(handle: string): string {
	const space = handle.indexOf(" ");
	return space < 0 ? handle : handle.slice(space + 1);
}

/** The effect part of a `<effect> <decisionId>` gate handle. */
export function handleEffect(handle: string): string {
	const space = handle.indexOf(" ");
	return space < 0 ? "" : handle.slice(0, space);
}

const IN_FLIGHT_ORDER: ReadonlyArray<readonly [StepName, PromotionState]> = [
	[STEP.verification, PromotionState.VERIFYING],
	[STEP.rollout, PromotionState.ROLLING_OUT],
	[STEP.applied, PromotionState.ROLLING_OUT],
	[STEP.beforeApply, PromotionState.APPLYING],
	[STEP.approved, PromotionState.APPLYING],
	[STEP.approvalRequested, PromotionState.AWAITING_APPROVAL],
	[STEP.awaitingWindow, PromotionState.AWAITING_WINDOW],
	[STEP.gated, PromotionState.RESOLVING],
	[STEP.resolved, PromotionState.RESOLVING],
];

const RANK: ReadonlyMap<PromotionState, number> = new Map([
	[PromotionState.QUEUED, 0],
	[PromotionState.RESOLVING, 1],
	[PromotionState.AWAITING_WINDOW, 2],
	[PromotionState.AWAITING_APPROVAL, 3],
	[PromotionState.APPLYING, 4],
	[PromotionState.ROLLING_OUT, 5],
	[PromotionState.VERIFYING, 6],
]);

/** State of one Camp still in flight. */
export function campState(progress: CampProgress): PromotionState {
	if (progress.steps.has(STEP.qualified)) return PromotionState.VERIFYING;
	const awaitingWindow =
		progress.steps.has(STEP.awaitingWindow) &&
		!progress.steps.has(STEP.gated);
	if (awaitingWindow) return PromotionState.AWAITING_WINDOW;
	for (const [step, state] of IN_FLIGHT_ORDER) {
		if (step === STEP.awaitingWindow) continue;
		if (progress.steps.has(step)) return state;
	}
	return PromotionState.QUEUED;
}

/** Overall state: terminal when every Camp is; otherwise the least advanced Camp. */
export function overallState(view: PromotionView): PromotionState {
	if (view.rolledBack) return PromotionState.ROLLED_BACK;
	const camps = [...view.camps.values()];
	if (camps.length > 0 && camps.every((camp) => camp.terminal !== undefined)) {
		if (camps.some((camp) => camp.terminal === "failed" || camp.terminal === "compensated"))
			return PromotionState.FAILED;
		if (camps.some((camp) => camp.terminal === "rejected"))
			return PromotionState.REJECTED;
		if (camps.every((camp) => camp.terminal === "superseded"))
			return PromotionState.SUPERSEDED;
		return PromotionState.PROMOTED;
	}
	let least: PromotionState | undefined;
	for (const camp of camps) {
		if (camp.terminal !== undefined) continue;
		const state = campState(camp);
		if (least === undefined || (RANK.get(state) ?? 0) < (RANK.get(least) ?? 0))
			least = state;
	}
	return least ?? PromotionState.QUEUED;
}

/** The PromotionRecord a reader sees: the request with folded state and reasons. */
export function recordOf(view: PromotionView): PromotionRecord {
	if (view.rolledBack && view.camps.size === 0) return view.rolledBack;
	const reasons = [...view.camps.values()].flatMap((camp) => camp.reasons);
	return create(PromotionRecordSchema, {
		...view.request,
		state: overallState(view),
		gateDecisionId: view.gateDecisionId || view.request.gateDecisionId,
		reasons: [...view.request.reasons, ...reasons],
	});
}
