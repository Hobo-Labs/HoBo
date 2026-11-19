import { createHash } from "node:crypto";
import { fromJsonString } from "@bufbuild/protobuf";
import {
	type SloBudgetObservationRecord,
	SloBudgetObservationRecordSchema,
	type SloBudgetProjectionRecord,
	type SloDeclaredRecord,
} from "../_generated/slo_pb.js";
import {
	createEventEnvelope,
	type EventEnvelope,
	parseEventEnvelope,
} from "../envelope.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	type JsonValue,
} from "../json.js";
import {
	hashSloDefinition,
	parseSloDefinition,
	type SloDefinition,
} from "./slo.js";
import type { SloEvaluation, SloWindowEvaluation } from "./slo-computation.js";

export const SLO_EVENT_SCHEMA = "hobo.slo.event/v1";
export type SloEventContext = Pick<
	EventEnvelope,
	| "id"
	| "seq"
	| "ts"
	| "actor"
	| "tenant"
	| "project"
	| "causationId"
	| "correlationId"
	| "meta"
>;
export type SloDeclared = Readonly<Omit<SloDeclaredRecord, "$typeName">>;
export type SloBudgetObservation = Readonly<
	Omit<SloBudgetObservationRecord, "$typeName">
>;
export type SloBudgetProjection = Readonly<
	Omit<SloBudgetProjectionRecord, "$typeName">
>;

export class SloBudgetProjectionError extends Error {
	readonly code = "slo.budget.projection.invalid";
}

function invalid(message: string): never {
	throw new SloBudgetProjectionError(message);
}

function observation(input: JsonValue): SloBudgetObservation {
	if (!isJsonObject(input))
		return invalid("SLO budget observation must be an object");
	for (const field of ["good", "total", "burnRate", "remainingBudgetRatio"]) {
		if (!isJsonNumber(input[field]) || !Number.isFinite(input[field]))
			invalid(`${field} must be a finite number`);
	}
	let record: SloBudgetObservationRecord;
	try {
		record = fromJsonString(
			SloBudgetObservationRecordSchema,
			JSON.stringify(input),
		);
	} catch {
		return invalid(
			"SLO budget observation does not match its protobuf contract",
		);
	}
	if (
		record.schema !== SLO_EVENT_SCHEMA ||
		!record.sloName.trim() ||
		!record.objective.trim() ||
		!record.window.trim()
	)
		invalid("SLO budget observation identity is required");
	if (
		record.good < 0 ||
		record.total <= 0 ||
		record.good > record.total ||
		record.burnRate < 0 ||
		record.remainingBudgetRatio < 0 ||
		record.remainingBudgetRatio > 1
	)
		invalid("SLO budget observation values are out of range");
	return Object.freeze({
		schema: SLO_EVENT_SCHEMA,
		sloName: record.sloName,
		objective: record.objective,
		window: record.window,
		good: record.good,
		total: record.total,
		burnRate: record.burnRate,
		remainingBudgetRatio: record.remainingBudgetRatio,
	});
}

function envelope<T>(
	context: SloEventContext,
	type: string,
	sloName: string,
	data: T,
): EventEnvelope<T> {
	const event = createEventEnvelope({
		...context,
		type,
		streamId: `slo:${sloName}`,
		data,
	});
	return Object.freeze({ ...event, data });
}

export function makeSloDeclaredEvent(
	definition: SloDefinition,
	context: SloEventContext,
): EventEnvelope<SloDeclared> {
	const slo = parseSloDefinition(cloneAsJson(definition));
	const data = Object.freeze({
		schema: SLO_EVENT_SCHEMA,
		sloName: slo.metadata.name,
		definitionHash: hashSloDefinition(slo),
	});
	return envelope(context, "slo.Declared", slo.metadata.name, data);
}

function usable(window: SloWindowEvaluation): window is SloWindowEvaluation & {
	good: number;
	total: number;
	burnRate: number;
} {
	return (
		window.status === "ok" &&
		window.good !== undefined &&
		window.total !== undefined &&
		window.burnRate !== undefined
	);
}

export function makeSloBudgetEvent(
	evaluation: SloEvaluation,
	objectiveName: string,
	context: SloEventContext,
): EventEnvelope<SloBudgetObservation> | undefined {
	const objective = evaluation.objectives.find(
		(item) => item.displayName === objectiveName,
	);
	if (!objective) return invalid(`unknown objective: ${objectiveName}`);
	if (
		objective.status !== "healthy" &&
		objective.status !== "burning" &&
		objective.status !== "budget-exhausted"
	)
		return undefined;
	const remaining = objective.window.remainingBudgetRatio;
	if (remaining === undefined || !usable(objective.window))
		return invalid("objective has no measurable budget");
	const burning = objective.burnWindows
		.filter((item) => item.triggered && usable(item.window))
		.sort((a, b) => (b.window.burnRate ?? 0) - (a.window.burnRate ?? 0))[0];
	const selected = burning?.window ?? objective.window;
	if (!usable(selected)) return invalid("burn window has no measurable budget");
	const data = observation({
		schema: SLO_EVENT_SCHEMA,
		sloName: evaluation.sloName,
		objective: objective.displayName,
		window: burning?.name ?? "objective",
		good: selected.good,
		total: selected.total,
		burnRate: selected.burnRate,
		remainingBudgetRatio: remaining,
	});
	return envelope(
		context,
		remaining === 0 ? "slo.BudgetExhausted" : "slo.BudgetBurned",
		evaluation.sloName,
		data,
	);
}

export function initialSloBudgetProjection(
	definition: SloDefinition,
	objectiveName: string,
): SloBudgetProjection {
	const slo = parseSloDefinition(cloneAsJson(definition));
	const objective = slo.spec.objectives.find(
		(item) => item.displayName === objectiveName,
	);
	if (!objective) return invalid(`unknown objective: ${objectiveName}`);
	if (objective.target === 1)
		return Object.freeze({
			sloName: slo.metadata.name,
			objective: objectiveName,
			gateable: false,
			consumedBudgetRatio: 0,
			remainingBudgetRatio: 0,
			exhausted: false,
			reason: "objective-has-no-error-budget",
		});
	return Object.freeze({
		sloName: slo.metadata.name,
		objective: objectiveName,
		gateable: true,
		consumedBudgetRatio: 0,
		remainingBudgetRatio: 1,
		exhausted: false,
	});
}

function consumedRatio(remaining: number): number {
	const value = 1 - remaining;
	const rounded = Number(value.toFixed(12));
	return (rounded === 0 && value > 0) || (rounded === 1 && value !== 1)
		? value
		: rounded;
}

export function applySloBudgetEvent(
	projection: SloBudgetProjection,
	input: EventEnvelope,
): SloBudgetProjection {
	const event = parseEventEnvelope(cloneAsJson(input));
	if (event.type !== "slo.BudgetBurned" && event.type !== "slo.BudgetExhausted")
		return projection;
	const data = observation(cloneAsJson(event.data));
	if (event.streamId !== `slo:${data.sloName}`)
		return invalid("SLO event stream does not match its data");
	if (event.type === "slo.BudgetExhausted" && data.remainingBudgetRatio !== 0)
		return invalid("exhausted event must have zero remaining budget");
	if (
		!projection.gateable ||
		data.sloName !== projection.sloName ||
		data.objective !== projection.objective
	)
		return projection;
	const digest = `sha256:${createHash("sha256")
		.update(JSON.stringify({ type: event.type, data }))
		.digest("hex")}`;
	if (projection.lastSeq !== undefined && event.seq <= projection.lastSeq) {
		if (
			event.seq === projection.lastSeq &&
			event.id === projection.lastEventId &&
			digest === projection.lastEventHash
		)
			return projection;
		return invalid(
			"SLO budget event sequence must advance without conflicting duplicates",
		);
	}
	return Object.freeze({
		...projection,
		consumedBudgetRatio: consumedRatio(data.remainingBudgetRatio),
		remainingBudgetRatio: data.remainingBudgetRatio,
		exhausted: data.remainingBudgetRatio === 0,
		lastSeq: event.seq,
		lastEventId: event.id,
		lastEventHash: digest,
	});
}

export function replaySloBudgetProjection(
	definition: SloDefinition,
	objective: string,
	events: readonly EventEnvelope[],
): SloBudgetProjection {
	return [...events]
		.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.reduce(
			applySloBudgetEvent,
			initialSloBudgetProjection(definition, objective),
		);
}
