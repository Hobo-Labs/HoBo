import { Temporal } from "@js-temporal/polyfill";
import type {
	SliSampleRecord,
	SloBurnEvaluationRecord,
	SloEvaluationRecord,
	SloObjectiveEvaluationRecord,
	SloWindowEvaluationRecord,
} from "../_generated/slo_pb.js";
import { cloneAsJson } from "../json.js";
import {
	parseSloDefinition,
	parseSloDuration,
	type SloDefinition,
	type SloDuration,
	type SloObjective,
	sloDurationMs,
} from "./slo.js";

export const SLO_COMPUTATION_SCHEMA = "hobo.slo-computation-engine/v1";
export type SliSample = Readonly<Omit<SliSampleRecord, "$typeName">>;
export type SliSource = Readonly<{
	readRatioSamples(
		query: Readonly<{ definition: SloDefinition; from: string; to: string }>,
	): Promise<readonly SliSample[]> | readonly SliSample[];
}>;
export type SloEvaluationStatus =
	| "healthy"
	| "burning"
	| "budget-exhausted"
	| "no-data"
	| "stale"
	| "invalid-sli"
	| "no-error-budget";
export type SloWindowEvaluation = Readonly<
	Omit<SloWindowEvaluationRecord, "$typeName" | "status"> & {
		status: "ok" | "no-data" | "invalid-sli";
	}
>;
export type SloBurnEvaluation = Readonly<
	Omit<SloBurnEvaluationRecord, "$typeName" | "window"> & {
		window: SloWindowEvaluation;
	}
>;
export type SloObjectiveEvaluation = Readonly<
	Omit<
		SloObjectiveEvaluationRecord,
		"$typeName" | "status" | "window" | "burnWindows"
	> & {
		status: SloEvaluationStatus;
		window: SloWindowEvaluation;
		burnWindows: readonly SloBurnEvaluation[];
	}
>;
export type SloEvaluation = Readonly<
	Omit<SloEvaluationRecord, "$typeName" | "status" | "objectives"> & {
		status: SloEvaluationStatus;
		objectives: readonly SloObjectiveEvaluation[];
	}
>;

type TimedSample = Readonly<SliSample & { timeMs: number }>;
type WindowBounds = Readonly<{ start: number; end: number }>;
type NormalizedSamples = Readonly<{ samples: TimedSample[]; invalid: boolean }>;
const MAX_SLICES = 1_000_000;
const STATUS_ORDER: readonly SloEvaluationStatus[] = [
	"invalid-sli",
	"no-data",
	"stale",
	"budget-exhausted",
	"burning",
	"no-error-budget",
	"healthy",
];

function instant(value: string): number {
	try {
		return Temporal.Instant.from(value).epochMilliseconds;
	} catch {
		throw new RangeError(`invalid instant: ${value}`);
	}
}

function iso(value: number): string {
	return new Date(value).toISOString();
}

function addCalendarDuration(
	start: Temporal.PlainDateTime,
	duration: SloDuration,
	index: number,
): Temporal.PlainDateTime {
	const count = duration.count * index;
	if (!Number.isSafeInteger(count))
		throw new RangeError("calendar duration exceeds safe precision");
	switch (duration.unit) {
		case "s":
			return start.add({ seconds: count });
		case "m":
			return start.add({ minutes: count });
		case "h":
			return start.add({ hours: count });
		case "d":
			return start.add({ days: count });
		case "w":
			return start.add({ weeks: count });
		case "M":
			return start.add({ months: count });
		case "Q":
			return start.add({ months: count * 3 });
		case "Y":
			return start.add({ years: count });
	}
}

function objectiveBounds(definition: SloDefinition, now: number): WindowBounds {
	const window = definition.spec.timeWindow;
	if (window.isRolling)
		return { start: now - sloDurationMs(window.duration), end: now };
	if (!window.calendar)
		throw new RangeError("calendar window requires an anchor");
	const anchor = Temporal.PlainDateTime.from(window.calendar.startTime);
	const zone = window.calendar.timeZone;
	const duration = parseSloDuration(window.duration, true);
	const boundary = (index: number): number => {
		try {
			return addCalendarDuration(anchor, duration, index).toZonedDateTime(
				zone,
				{ disambiguation: "compatible" },
			).epochMilliseconds;
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	};
	if (now < boundary(0))
		throw new RangeError("SLO calendar window has not started");
	let low = 0;
	let high = 1;
	while (boundary(high) <= now) {
		low = high;
		high *= 2;
		if (!Number.isSafeInteger(high))
			throw new RangeError("calendar window index exceeds safe precision");
	}
	while (high - low > 1) {
		const middle = low + Math.floor((high - low) / 2);
		if (boundary(middle) <= now) low = middle;
		else high = middle;
	}
	const start = boundary(low);
	if (!Number.isFinite(start))
		throw new RangeError("calendar boundary is out of range");
	return { start, end: now };
}

function normalizedSamples(
	samples: readonly SliSample[],
	bounds: WindowBounds,
): NormalizedSamples {
	const result: TimedSample[] = [];
	for (const sample of samples) {
		let timeMs: number;
		try {
			timeMs = instant(sample.time);
		} catch {
			return { samples: [], invalid: true };
		}
		if (timeMs <= bounds.start || timeMs > bounds.end) continue;
		if (
			!Number.isFinite(sample.good) ||
			!Number.isFinite(sample.total) ||
			sample.good < 0 ||
			sample.total < 0 ||
			sample.good > sample.total
		)
			return { samples: [], invalid: true };
		result.push({ ...sample, timeMs });
	}
	result.sort((a, b) => a.timeMs - b.timeMs);
	return { samples: result, invalid: false };
}

function windowEvaluation(
	definition: SloDefinition,
	objective: SloObjective,
	samples: readonly TimedSample[],
	bounds: WindowBounds,
	invalid: boolean,
): SloWindowEvaluation {
	const empty = {
		startTime: iso(bounds.start),
		endTime: iso(bounds.end),
		slices: 0,
	};
	if (invalid) return { ...empty, status: "invalid-sli" };
	if (samples.length === 0 || bounds.end <= bounds.start)
		return { ...empty, status: "no-data" };
	let good = 0;
	let total = 0;
	let slices = 0;
	if (definition.spec.budgetingMethod === "Occurrences") {
		for (const sample of samples) {
			good += sample.good;
			total += sample.total;
		}
	} else {
		if (!objective.timeSliceWindow)
			throw new RangeError("time-slice window is required");
		const sliceMs = sloDurationMs(objective.timeSliceWindow);
		slices = Math.ceil((bounds.end - bounds.start) / sliceMs);
		if (!Number.isSafeInteger(slices) || slices > MAX_SLICES)
			throw new RangeError("time-slice count exceeds the supported limit");
		const groups = new Map<number, { good: number; total: number }>();
		for (const sample of samples) {
			const index = Math.ceil((sample.timeMs - bounds.start) / sliceMs) - 1;
			const group = groups.get(index) ?? { good: 0, total: 0 };
			group.good += sample.good;
			group.total += sample.total;
			groups.set(index, group);
		}
		if (groups.size !== slices) return { ...empty, slices, status: "no-data" };
		for (const group of groups.values()) {
			if (!Number.isFinite(group.good) || !Number.isFinite(group.total))
				throw new RangeError("SLI sample counts overflow");
			if (group.total === 0) return { ...empty, slices, status: "no-data" };
			const ratio = group.good / group.total;
			if (definition.spec.budgetingMethod === "Timeslices") {
				if (objective.timeSliceTarget === undefined)
					throw new RangeError("time-slice target is required");
				if (ratio >= objective.timeSliceTarget) good++;
			} else good += ratio;
			total++;
		}
	}
	if (!Number.isFinite(good) || !Number.isFinite(total))
		throw new RangeError("SLI sample counts overflow");
	if (total === 0) return { ...empty, slices, status: "no-data" };
	const errors = Math.max(0, total - good);
	const errorBudget = total * (1 - objective.target);
	if (objective.target === 1)
		return { ...empty, slices, status: "ok", good, total, errors, errorBudget };
	if (errorBudget === 0) throw new RangeError("SLI error budget underflows");
	const burnRate = errors / total / (1 - objective.target);
	if (!Number.isFinite(burnRate))
		throw new RangeError("SLI burn rate overflow");
	const remainingBudgetRatio =
		good / total <= objective.target
			? 0
			: Math.max(0, Math.min(1, (errorBudget - errors) / errorBudget));
	return {
		...empty,
		slices,
		status: "ok",
		good,
		total,
		errors,
		errorBudget,
		burnRate,
		remainingBudgetRatio,
	};
}

function combineStatus(
	statuses: readonly SloEvaluationStatus[],
): SloEvaluationStatus {
	return STATUS_ORDER.find((status) => statuses.includes(status)) ?? "no-data";
}

export async function computeSloStatus(
	options: Readonly<{
		definition: SloDefinition;
		sliSource: SliSource;
		now: string;
		maxStaleness?: string;
	}>,
): Promise<SloEvaluation> {
	const definition = parseSloDefinition(cloneAsJson(options.definition));
	const { sliSource } = options;
	const now = instant(options.now);
	const staleness = sloDurationMs(options.maxStaleness ?? "10m");
	const bounds = objectiveBounds(definition, now);
	const raw = await sliSource.readRatioSamples({
		definition,
		from: iso(bounds.start),
		to: iso(bounds.end),
	});
	const observed = normalizedSamples(raw, bounds);
	const latest = observed.samples.at(-1);
	const stale = latest !== undefined && now - latest.timeMs > staleness;
	const objectives = definition.spec.objectives.map(
		(objective): SloObjectiveEvaluation => {
			const window = windowEvaluation(
				definition,
				objective,
				observed.samples,
				bounds,
				observed.invalid,
			);
			const burnWindows = definition.spec.burnRateThresholds.map(
				(threshold): SloBurnEvaluation => {
					const lookback = Math.max(
						bounds.start,
						now - sloDurationMs(threshold.lookbackWindow),
					);
					const samples = observed.samples.filter(
						(sample) => sample.timeMs > lookback,
					);
					const metrics = windowEvaluation(
						definition,
						objective,
						samples,
						{ start: lookback, end: now },
						observed.invalid,
					);
					const thresholdErrorRate =
						threshold.threshold * (1 - objective.target);
					const tolerance = Math.min(
						thresholdErrorRate * 1e-8,
						Number.EPSILON * threshold.threshold * 2,
					);
					const triggered =
						metrics.burnRate !== undefined &&
						metrics.errors !== undefined &&
						metrics.errors > 0 &&
						metrics.total !== undefined &&
						metrics.total > 0 &&
						metrics.errors / metrics.total >= thresholdErrorRate - tolerance;
					return {
						name: threshold.name,
						threshold: threshold.threshold,
						lookbackWindow: threshold.lookbackWindow,
						samplingInterval: threshold.samplingInterval,
						triggered,
						window: metrics,
					};
				},
			);
			let status: SloEvaluationStatus;
			if (window.status !== "ok") status = window.status;
			else if (stale) status = "stale";
			else if (objective.target === 1) status = "no-error-budget";
			else if (burnWindows.some((item) => item.window.status !== "ok"))
				status = combineStatus(
					burnWindows.map((item) =>
						item.window.status === "ok" ? "healthy" : item.window.status,
					),
				);
			else if (window.remainingBudgetRatio === 0) status = "budget-exhausted";
			else if (burnWindows.some((item) => item.triggered)) status = "burning";
			else status = "healthy";
			return {
				displayName: objective.displayName,
				target: objective.target,
				status,
				window,
				burnWindows,
			};
		},
	);
	return {
		schema: SLO_COMPUTATION_SCHEMA,
		sloName: definition.metadata.name,
		service: definition.spec.service,
		evaluatedAt: iso(now),
		status: combineStatus(objectives.map((item) => item.status)),
		objectives,
	};
}
