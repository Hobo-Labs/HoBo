import { createHash } from "node:crypto";
import { fromJsonString } from "@bufbuild/protobuf";
import { Temporal } from "@js-temporal/polyfill";
import {
	type SloBurnThresholdRecord,
	type SloCalendarRecord,
	type SloDefinitionRecord,
	SloDefinitionRecordSchema,
	type SloMetadataRecord,
	type SloObjectiveRecord,
	type SloSpecRecord,
	type SloTelemetryRecord,
} from "../_generated/slo_pb.js";
import { cloneAsJson, type JsonValue } from "../json.js";

export const SLO_SCHEMA = "hobo.slo/v1";
export const OPEN_SLO_API_VERSION = "openslo/v1";
export type SloBudgetingMethod =
	| "Occurrences"
	| "Timeslices"
	| "RatioTimeslices";
export type SloTelemetry = Readonly<Omit<SloTelemetryRecord, "$typeName">>;
export type SloCalendar = Readonly<Omit<SloCalendarRecord, "$typeName">>;
export type SloObjective = Readonly<Omit<SloObjectiveRecord, "$typeName">>;
export type SloBurnThreshold = Readonly<
	Omit<SloBurnThresholdRecord, "$typeName">
>;
export type SloMetadata = Readonly<
	Omit<SloMetadataRecord, "$typeName" | "labels"> & {
		labels: Readonly<Record<string, string>>;
	}
>;
export type SloTimeWindow = Readonly<{
	duration: string;
	isRolling: boolean;
	calendar?: SloCalendar;
}>;
export type SloSpec = Readonly<
	Omit<
		SloSpecRecord,
		| "$typeName"
		| "indicator"
		| "timeWindow"
		| "budgetingMethod"
		| "objectives"
		| "burnRateThresholds"
	> & {
		indicator: Readonly<{
			ratioMetric: Readonly<{
				counter: boolean;
				good: Readonly<{ telemetry: SloTelemetry }>;
				total: Readonly<{ telemetry: SloTelemetry }>;
			}>;
		}>;
		timeWindow: SloTimeWindow;
		budgetingMethod: SloBudgetingMethod;
		objectives: readonly SloObjective[];
		burnRateThresholds: readonly SloBurnThreshold[];
	}
>;
export type SloDefinition = Readonly<
	Omit<SloDefinitionRecord, "$typeName" | "metadata" | "spec"> & {
		metadata: SloMetadata;
		spec: SloSpec;
	}
>;
export type SloDuration = Readonly<{
	count: number;
	unit: "s" | "m" | "h" | "d" | "w" | "M" | "Q" | "Y";
}>;

export class SloDefinitionError extends Error {
	readonly code = "slo.definition.invalid";
}

function invalid(message: string): never {
	throw new SloDefinitionError(message);
}

function required(value: string, name: string): string {
	if (value.trim().length === 0) invalid(`${name} must be nonempty`);
	return value;
}

export function parseSloDuration(
	value: string,
	allowCalendar = false,
): SloDuration {
	const match = /^([1-9][0-9]*)(s|m|h|d|w|M|Q|Y)$/u.exec(value);
	if (!match) return invalid(`invalid duration: ${value}`);
	const count = Number(match[1]);
	const unit = match[2];
	if (!Number.isSafeInteger(count) || unit === undefined)
		return invalid(`invalid duration: ${value}`);
	if (
		unit === "s" ||
		unit === "m" ||
		unit === "h" ||
		unit === "d" ||
		unit === "w"
	) {
		const multiplier = {
			s: 1000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
			w: 604_800_000,
		}[unit];
		if (!Number.isSafeInteger(count * multiplier))
			invalid(`duration exceeds safe precision: ${value}`);
		return { count, unit };
	}
	if (allowCalendar && (unit === "M" || unit === "Q" || unit === "Y"))
		return { count, unit };
	return invalid(`calendar duration requires a calendar window: ${value}`);
}

export function sloDurationMs(value: string): number {
	const { count, unit } = parseSloDuration(value);
	switch (unit) {
		case "s":
			return count * 1000;
		case "m":
			return count * 60_000;
		case "h":
			return count * 3_600_000;
		case "d":
			return count * 86_400_000;
		case "w":
			return count * 604_800_000;
		default:
			return invalid(`calendar duration has no fixed length: ${value}`);
	}
}

function ratio(value: number | undefined, name: string): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 1)
		return invalid(`${name} must be greater than 0 and at most 1`);
	return value;
}

function calendar(value: SloCalendarRecord | undefined): SloCalendar {
	if (!value) return invalid("calendar is required for a non-rolling window");
	const startTime = required(value.startTime, "calendar.startTime");
	const timeZone = required(value.timeZone, "calendar.timeZone");
	if (
		!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(startTime)
	)
		invalid("calendar.startTime must be a local date and time");
	try {
		Temporal.PlainDateTime.from(startTime).toZonedDateTime(timeZone, {
			disambiguation: "reject",
		});
	} catch {
		return invalid("calendar start time or time zone is invalid or ambiguous");
	}
	return Object.freeze({ startTime, timeZone });
}

function telemetry(
	value: SloTelemetryRecord | undefined,
	name: string,
): SloTelemetry {
	if (!value) return invalid(`${name} is required`);
	const query = required(value.query, `${name}.query`);
	const result: Omit<SloTelemetryRecord, "$typeName"> = { query };
	if (value.unit !== undefined)
		result.unit = required(value.unit, `${name}.unit`);
	return Object.freeze(result);
}

export function parseSloDefinition(input: JsonValue): SloDefinition {
	let record: SloDefinitionRecord;
	try {
		record = fromJsonString(SloDefinitionRecordSchema, JSON.stringify(input));
	} catch {
		return invalid("SLO definition does not match its protobuf contract");
	}
	if (
		record.schema !== SLO_SCHEMA ||
		record.apiVersion !== OPEN_SLO_API_VERSION ||
		record.kind !== "SLO"
	)
		invalid("unsupported SLO schema, API version, or kind");
	if (!record.metadata || !record.spec)
		return invalid("SLO metadata and spec are required");
	const metadata = Object.freeze({
		name: required(record.metadata.name, "metadata.name"),
		labels: Object.freeze(
			Object.fromEntries(
				Object.entries(record.metadata.labels).sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				),
			),
		),
	});
	const spec = record.spec;
	const service = required(spec.service, "spec.service");
	const metric = spec.indicator?.ratioMetric;
	if (!metric || metric.counter === undefined)
		return invalid("ratio metric and counter are required");
	const good = Object.freeze({
		telemetry: telemetry(metric.good?.telemetry, "good.telemetry"),
	});
	const total = Object.freeze({
		telemetry: telemetry(metric.total?.telemetry, "total.telemetry"),
	});
	const indicator = Object.freeze({
		ratioMetric: Object.freeze({ counter: metric.counter, good, total }),
	});
	const window = spec.timeWindow;
	if (!window || window.isRolling === undefined)
		return invalid("timeWindow and isRolling are required");
	parseSloDuration(window.duration, !window.isRolling);
	if (window.isRolling && window.calendar)
		invalid("rolling windows cannot specify a calendar");
	const timeWindow = window.isRolling
		? Object.freeze({ duration: window.duration, isRolling: true })
		: Object.freeze({
				duration: window.duration,
				isRolling: false,
				calendar: calendar(window.calendar),
			});
	const method = spec.budgetingMethod;
	if (
		method !== "Occurrences" &&
		method !== "Timeslices" &&
		method !== "RatioTimeslices"
	)
		return invalid("unsupported budgeting method");
	if (spec.objectives.length === 0)
		invalid("at least one objective is required");
	const names = new Set<string>();
	const objectives = Object.freeze(
		spec.objectives.map((item) => {
			const displayName = required(item.displayName, "objective.displayName");
			if (names.has(displayName))
				invalid(`duplicate objective: ${displayName}`);
			names.add(displayName);
			const target = ratio(item.target, "objective.target");
			if (
				method === "Occurrences" &&
				(item.timeSliceWindow !== undefined ||
					item.timeSliceTarget !== undefined)
			)
				invalid("occurrence objectives cannot specify time slices");
			if (method !== "Occurrences" && item.timeSliceWindow === undefined)
				invalid("time-slice objectives require a timeSliceWindow");
			if (item.timeSliceWindow !== undefined) {
				const sliceMs = sloDurationMs(item.timeSliceWindow);
				if (window.isRolling && sliceMs > sloDurationMs(window.duration))
					invalid("time slice exceeds objective window");
			}
			if (method === "Timeslices")
				ratio(item.timeSliceTarget, "objective.timeSliceTarget");
			if (method === "RatioTimeslices" && item.timeSliceTarget !== undefined)
				invalid("ratio time slices cannot specify timeSliceTarget");
			const objective: Omit<SloObjectiveRecord, "$typeName"> = {
				displayName,
				target,
			};
			if (item.timeSliceWindow !== undefined)
				objective.timeSliceWindow = item.timeSliceWindow;
			if (item.timeSliceTarget !== undefined)
				objective.timeSliceTarget = item.timeSliceTarget;
			return Object.freeze(objective);
		}),
	);
	const thresholdNames = new Set<string>();
	const burnRateThresholds = Object.freeze(
		spec.burnRateThresholds.map((item) => {
			const name = required(item.name, "burn threshold name");
			if (thresholdNames.has(name))
				invalid(`duplicate burn threshold: ${name}`);
			thresholdNames.add(name);
			if (!Number.isFinite(item.threshold) || item.threshold <= 0)
				invalid("burn threshold must be positive and finite");
			const lookback = sloDurationMs(item.lookbackWindow);
			const sampling = sloDurationMs(item.samplingInterval);
			if (sampling > lookback)
				invalid("sampling interval exceeds lookback window");
			if (window.isRolling && lookback > sloDurationMs(window.duration))
				invalid("lookback exceeds objective window");
			return Object.freeze({
				name,
				threshold: item.threshold,
				lookbackWindow: item.lookbackWindow,
				samplingInterval: item.samplingInterval,
			});
		}),
	);
	return Object.freeze({
		schema: SLO_SCHEMA,
		apiVersion: OPEN_SLO_API_VERSION,
		kind: "SLO",
		metadata,
		spec: Object.freeze({
			service,
			indicator,
			timeWindow,
			budgetingMethod: method,
			objectives,
			burnRateThresholds,
		}),
	});
}

export function serializeSloDefinition(definition: SloDefinition): string {
	return JSON.stringify(parseSloDefinition(cloneAsJson(definition)));
}

export function hashSloDefinition(definition: SloDefinition): string {
	return `sha256:${createHash("sha256").update(serializeSloDefinition(definition)).digest("hex")}`;
}
