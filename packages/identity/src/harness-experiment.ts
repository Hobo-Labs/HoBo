/**
 * OpenExperiment port (hobo:experiment) — assignment, exposure, tracking hooks.
 * Heavy statistical analysis remains behind pluggable adapters (not in core).
 */

import { createHash, randomUUID } from "node:crypto";
import {
	type ExperimentFlagAllocation,
	experimentAllocation,
	pickExperimentVariant,
	sameExperimentAllocation,
} from "./experiment-allocation.js";
import {
	type DetailEvaluation,
	experimentSubjectKey,
	type FeatureFlagPort,
	type FlagDefinition,
	type FlagDefinitionInput,
	type FlagEvalContext,
	type FlagValue,
	flagContextBinding,
} from "./feature-flag-store.js";
import { type JsonObject, sameJson } from "./json.js";

// public-contract: OpenExperiment port id.
export const EXPERIMENT_PORT = "hobo:experiment" as const;

// public-contract: experiment event schema.
export const EXPERIMENT_EVENT_SCHEMA = "hobo.experiment-events/v1" as const;

export const EXPERIMENT_EVENTS = Object.freeze({
	Assigned: "experiment.Assigned",
	Exposed: "experiment.Exposed",
	Concluded: "experiment.Concluded",
} as const);

export type ExperimentEvent = Readonly<{
	id: string;
	type: (typeof EXPERIMENT_EVENTS)[keyof typeof EXPERIMENT_EVENTS];
	schemaVersion: typeof EXPERIMENT_EVENT_SCHEMA;
	seq: number;
	time: string;
	data: JsonObject;
}>;

export type ExperimentDefinition = Readonly<{
	name: string;
	flag: string;
	variants: readonly string[];
	allocation?: Readonly<{
		/** Percent weights per variant (optional; else equal split). */
		weights?: Readonly<Record<string, number>>;
	}>;
	metrics?: readonly string[];
}>;

export type ExperimentAssignment = Readonly<{
	experiment: string;
	flag: string;
	variant: string;
	subjectKey: string;
	tenant?: string;
	assignedAt: string;
	assignedVariant?: string;
	reason?: DetailEvaluation["reason"];
}>;

export type ExperimentEvaluationExposure = Readonly<{
	assignment: ExperimentAssignment;
	evaluation: DetailEvaluation;
}>;

export interface ExperimentPort {
	readonly events: readonly ExperimentEvent[];
	validateDefinition?(definition: ExperimentDefinition): void;
	define(definition: ExperimentDefinition): ExperimentDefinition;
	assign(
		experimentName: string,
		context: FlagEvalContext,
	): ExperimentAssignment;
	expose(
		experimentName: string,
		context: FlagEvalContext,
		defaultValue?: FlagValue,
	): void;
	evaluateAndExpose(
		experimentName: string,
		context: FlagEvalContext,
		defaultValue?: FlagValue,
	): ExperimentAssignment;
	exposeEvaluated?(
		experimentName: string,
		context: FlagEvalContext,
		evaluation: DetailEvaluation,
	): ExperimentAssignment;
	evaluateAndExposeDetails?(
		experimentName: string,
		context: FlagEvalContext,
		defaultValue?: FlagValue,
	): ExperimentEvaluationExposure;
	conclude(
		experimentName: string,
		verdict: "ship" | "do-not-ship" | "inconclusive",
		reason?: string,
	): void;
	getAssignment(
		experimentName: string,
		subjectKey: string,
		tenant?: string,
	): ExperimentAssignment | undefined;
	list(): readonly ExperimentDefinition[];
}

/**
 * Built-in experiment engine: sticky assignment + exposure tracking + OTEL-shaped hooks.
 */
export class OpenExperimentEngine implements ExperimentPort {
	readonly events: ExperimentEvent[] = [];
	private seq = 0;
	private readonly defs = new Map<string, ExperimentDefinition>();
	private readonly assignments = new Map<
		string,
		Map<string, ExperimentAssignment>
	>();
	private readonly allocations = new Map<string, ExperimentFlagAllocation>();
	private readonly now: () => string;
	private readonly store: FeatureFlagPort;
	/** OTEL-shaped emission hook (no hard OTEL dependency). */
	private readonly emitOtel?: (span: {
		readonly name: string;
		readonly attributes: Readonly<Record<string, string | number | boolean>>;
	}) => void;

	constructor(options: {
		readonly store: FeatureFlagPort;
		readonly now?: () => string;
		readonly emitOtel?: (span: {
			readonly name: string;
			readonly attributes: Readonly<Record<string, string | number | boolean>>;
		}) => void;
	}) {
		this.store = options.store;
		this.now = options.now ?? (() => new Date().toISOString());
		this.emitOtel = options.emitOtel;
	}

	validateDefinition(def: ExperimentDefinition): void {
		this.prepareDefinition(def);
	}

	private prepareDefinition(def: ExperimentDefinition) {
		if (!def.flag) throw new TypeError("experiment requires a flag");
		const apply = this.store.applyExperimentAllocation;
		if (this.store.experimentAllocationVersion !== 1 || !apply)
			throw Object.assign(
				new Error("the flag port does not support experiment allocation"),
				{ code: "experiment-allocation-unsupported" },
			);
		const existing = this.store.get(def.flag);
		if (
			existing?.metadata.experiment &&
			existing.metadata.experiment !== def.name
		)
			throw Object.assign(
				new Error("the flag is already bound to another experiment"),
				{ code: "experiment-allocation-conflict" },
			);
		const allocation = allocationFor(def, existing);
		const previous = this.defs.get(def.name);
		const previousAllocation = this.allocations.get(def.name);
		if (
			existing?.experimentAllocation &&
			existing.experimentAllocation.name !== def.name
		)
			throw Object.assign(
				new Error("the flag is already bound to another experiment allocation"),
				{ code: "experiment-allocation-conflict" },
			);
		if (
			existing?.experimentAllocation &&
			!sameExperimentAllocation(existing.experimentAllocation, allocation)
		)
			throw Object.assign(
				new Error(
					"the saved experiment allocation conflicts with this definition",
				),
				{ code: "experiment-allocation-conflict" },
			);
		if (previous && previous.flag !== def.flag)
			throw Object.assign(new Error("an experiment cannot change its flag"), {
				code: "experiment-allocation-conflict",
			});
		if (
			previousAllocation &&
			(this.assignments.get(def.name)?.size ?? 0) > 0 &&
			!sameExperimentAllocation(previousAllocation, allocation)
		)
			throw Object.assign(
				new Error(
					"an active experiment cannot change allocation after assignment",
				),
				{ code: "experiment-allocation-conflict" },
			);
		return { existing, allocation, apply };
	}

	define(def: ExperimentDefinition): ExperimentDefinition {
		const { existing, allocation, apply } = this.prepareDefinition(def);
		const frozen = Object.freeze({
			name: def.name,
			flag: def.flag,
			variants: Object.freeze([...def.variants]),
			...(def.allocation !== undefined
				? {
						allocation: Object.freeze({
							...(def.allocation.weights === undefined
								? undefined
								: { weights: Object.freeze({ ...def.allocation.weights }) }),
						}),
					}
				: undefined),
			...(def.metrics !== undefined
				? { metrics: Object.freeze([...def.metrics]) }
				: undefined),
		});
		const variants = Object.fromEntries(
			def.variants.map((variant) => [
				variant,
				variant === "treatment" || variant === "on"
					? true
					: variant === "control" || variant === "off"
						? false
						: variant,
			]),
		);
		const requested: FlagDefinitionInput = {
			key: def.flag,
			variants: { ...variants, ...existing?.variants },
			...(existing === undefined
				? {
						defaultVariant: def.variants[0] ?? "control",
						defaultValue: false,
						percentage: 100,
						enabled: true,
						state: "ENABLED" as const,
						killSwitch: false,
						autoAbortOnDualFailure: false,
					}
				: {
						defaultVariant: existing.defaultVariant,
						defaultValue: existing.defaultValue,
						percentage: existing.percentage,
						...(existing.suspendedPercentage === undefined
							? undefined
							: { suspendedPercentage: existing.suspendedPercentage }),
						enabled: existing.enabled,
						state: existing.state,
						killSwitch: existing.killSwitch,
						...(existing.targeting === undefined
							? undefined
							: { targeting: existing.targeting }),
						...(existing.migrationId === undefined
							? undefined
							: { migrationId: existing.migrationId }),
						autoAbortOnDualFailure: existing.autoAbortOnDualFailure,
					}),
			experimentAllocation: allocation,
			metadata: { ...existing?.metadata, experiment: def.name },
		};
		let configured: FlagDefinition;
		try {
			configured = apply.call(this.store, requested);
		} catch {
			throw Object.assign(
				new Error(
					"the experiment allocation apply may have partially changed the flag; reconcile before retrying",
				),
				{ code: "experiment-allocation-reconcile-required" },
			);
		}
		if (!acceptsAppliedConfiguration(configured, requested, allocation))
			throw Object.assign(
				new Error(
					"the flag port may have partially changed the flag; reconcile before retrying",
				),
				{ code: "experiment-allocation-reconcile-required" },
			);
		this.defs.set(def.name, frozen);
		this.allocations.set(def.name, allocation);
		return frozen;
	}

	/**
	 * Sticky assign subject to a variant (sampled event).
	 */
	assign(
		experimentName: string,
		context: FlagEvalContext,
	): ExperimentAssignment {
		const def = this.defs.get(experimentName);
		if (!def) {
			throw Object.assign(
				new Error(`experiment not defined: ${experimentName}`),
				{
					code: "experiment-missing",
				},
			);
		}
		const subjectKey = context.targetingKey;
		let subjects = this.assignments.get(experimentName);
		const subject = subjectIdentity(subjectKey, context.tenant);
		const existing = subjects?.get(subject);
		if (existing) return existing;
		const allocation = this.allocations.get(experimentName);
		const flag = this.store.get(def.flag);
		if (!allocation || !flag)
			throw Object.assign(
				new Error("the experiment allocation is unavailable"),
				{ code: "experiment-allocation-unavailable" },
			);
		const variant = pickExperimentVariant(
			allocation,
			experimentSubjectKey(flag, context),
		);
		const t = this.now();
		const assignment: ExperimentAssignment = Object.freeze({
			experiment: experimentName,
			flag: def.flag,
			variant,
			subjectKey,
			...(context.tenant === undefined
				? undefined
				: { tenant: context.tenant }),
			assignedAt: t,
		});
		if (!subjects) {
			subjects = new Map();
			this.assignments.set(experimentName, subjects);
		}
		subjects.set(subject, assignment);
		this.emit(EXPERIMENT_EVENTS.Assigned, {
			experiment: experimentName,
			flag: def.flag,
			variant,
			subjectKeyHash: hashSubject(subjectKey, context.tenant),
		});
		this.emitOtel?.({
			name: "experiment.assign",
			attributes: {
				"experiment.name": experimentName,
				"experiment.variant": variant,
				"flag.key": def.flag,
			},
		});
		return assignment;
	}

	/** Record exposure (subject actually saw the experience). */
	expose(
		experimentName: string,
		context: FlagEvalContext,
		defaultValue: FlagValue = false,
	): void {
		const assignment = this.assign(experimentName, context);
		this.recordExposure(
			assignment,
			this.store.evaluate(assignment.flag, context, defaultValue),
		);
	}

	exposeEvaluated(
		experimentName: string,
		context: FlagEvalContext,
		evaluation: DetailEvaluation,
	): ExperimentAssignment {
		const definition = this.defs.get(experimentName);
		if (!definition)
			throw Object.assign(
				new Error(`experiment not defined: ${experimentName}`),
				{ code: "experiment-missing" },
			);
		if (
			evaluation.flagKey !== definition.flag ||
			evaluation.contextBinding !== flagContextBinding(context)
		)
			throw Object.assign(
				new Error(
					"the evaluation does not match the experiment flag and context",
				),
				{ code: "experiment-evaluation-mismatch" },
			);
		return this.recordExposure(
			this.assign(experimentName, context),
			evaluation,
		);
	}

	private recordExposure(
		assignment: ExperimentAssignment,
		evaluation: DetailEvaluation,
	): ExperimentAssignment {
		const exposed =
			evaluation.variant === assignment.variant
				? assignment
				: Object.freeze({
						...assignment,
						variant: evaluation.variant,
						assignedVariant: assignment.variant,
						reason: evaluation.reason,
					});
		this.emit(EXPERIMENT_EVENTS.Exposed, {
			experiment: assignment.experiment,
			flag: assignment.flag,
			variant: evaluation.variant,
			assignedVariant: assignment.variant,
			reason: evaluation.reason,
			subjectKeyHash: hashSubject(assignment.subjectKey, assignment.tenant),
		});
		this.emitOtel?.({
			name: "experiment.expose",
			attributes: {
				"experiment.name": assignment.experiment,
				"experiment.variant": evaluation.variant,
			},
		});
		return exposed;
	}

	/** Evaluate flag and treat as exposure (common path). */
	evaluateAndExpose(
		experimentName: string,
		context: FlagEvalContext,
		defaultValue: FlagValue = false,
	): ExperimentAssignment {
		return this.evaluateAndExposeDetails(experimentName, context, defaultValue)
			.assignment;
	}

	evaluateAndExposeDetails(
		experimentName: string,
		context: FlagEvalContext,
		defaultValue: FlagValue = false,
	): ExperimentEvaluationExposure {
		const assignment = this.assign(experimentName, context);
		const evaluation = this.store.evaluate(
			assignment.flag,
			context,
			defaultValue,
		);
		return Object.freeze({
			assignment: this.recordExposure(assignment, evaluation),
			evaluation,
		});
	}

	conclude(
		experimentName: string,
		verdict: "ship" | "do-not-ship" | "inconclusive",
		reason?: string,
	): void {
		this.emit(EXPERIMENT_EVENTS.Concluded, {
			experiment: experimentName,
			verdict,
			...(reason !== undefined ? { reason } : undefined),
		});
	}

	getAssignment(
		experimentName: string,
		subjectKey: string,
		tenant?: string,
	): ExperimentAssignment | undefined {
		const subjects = this.assignments.get(experimentName);
		if (!subjects) return undefined;
		if (tenant !== undefined)
			return subjects.get(subjectIdentity(subjectKey, tenant));
		const matches = [...subjects.values()].filter(
			(assignment) => assignment.subjectKey === subjectKey,
		);
		return matches.length === 1 ? matches[0] : undefined;
	}

	list(): readonly ExperimentDefinition[] {
		return Object.freeze([...this.defs.values()]);
	}

	private emit(type: ExperimentEvent["type"], data: JsonObject): void {
		this.seq += 1;
		this.events.push(
			Object.freeze({
				id: `evt-${type}-${this.seq}`,
				type,
				schemaVersion: EXPERIMENT_EVENT_SCHEMA,
				seq: this.seq,
				time: this.now(),
				data: Object.freeze({ ...data }),
			}),
		);
	}
}

export function validateExperimentDefinition(def: ExperimentDefinition): void {
	if (!def.flag) throw new TypeError("experiment requires a flag");
	experimentAllocation(def.name, def.variants, def.allocation?.weights);
}

function allocationFor(
	def: ExperimentDefinition,
	existing: FlagDefinition | undefined,
): ExperimentFlagAllocation {
	const requested = experimentAllocation(
		def.name,
		def.variants,
		def.allocation?.weights,
	);
	const fractional = existing?.targeting?.fractional;
	if (!fractional) return requested;
	const rows = fractional.variants.map((row) => {
		const entries = Object.entries(row);
		if (entries.length !== 1 || entries[0] === undefined)
			throw new TypeError(
				"fractional allocation must name one variant per row",
			);
		return entries[0];
	});
	const variants = rows.map(([name]) => name);
	if (
		variants.length !== def.variants.length ||
		variants.some((name) => !def.variants.includes(name))
	)
		throw new TypeError(
			"fractional allocation does not match experiment variants",
		);
	const configured = experimentAllocation(
		def.name,
		variants,
		Object.fromEntries(rows),
		"fractional",
	);
	if (def.allocation?.weights && !sameWeights(requested, configured))
		throw new TypeError(
			"experiment allocation conflicts with existing fractional targeting",
		);
	if (
		(existing.killSwitch
			? (existing.suspendedPercentage ?? 0)
			: existing.percentage) !== 100 &&
		(!existing.experimentAllocation ||
			!sameExperimentAllocation(existing.experimentAllocation, configured))
	)
		throw new TypeError(
			"an existing fractional flag requires a 100 percent rollout before experiment attachment",
		);
	return configured;
}

function sameWeights(
	a: ExperimentFlagAllocation,
	b: ExperimentFlagAllocation,
): boolean {
	return (
		a.variants.length === b.variants.length &&
		a.variants.every((variant) => a.weights[variant] === b.weights[variant])
	);
}

function acceptsAppliedConfiguration(
	configured: FlagDefinition,
	requested: FlagDefinitionInput,
	allocation: ExperimentFlagAllocation,
): boolean {
	try {
		return Boolean(
			configured?.experimentAllocation &&
				configured.metadata &&
				configured.variants &&
				sameExperimentAllocation(configured.experimentAllocation, allocation) &&
				configured.key === requested.key &&
				configured.enabled === requested.enabled &&
				configured.state === requested.state &&
				configured.killSwitch === requested.killSwitch &&
				configured.percentage === requested.percentage &&
				configured.suspendedPercentage === requested.suspendedPercentage &&
				configured.defaultValue === requested.defaultValue &&
				configured.defaultVariant === requested.defaultVariant &&
				configured.migrationId === requested.migrationId &&
				configured.autoAbortOnDualFailure ===
					requested.autoAbortOnDualFailure &&
				sameJson(configured.targeting, requested.targeting) &&
				sameRecord(configured.variants, requested.variants) &&
				sameRecord(configured.metadata, requested.metadata),
		);
	} catch {
		return false;
	}
}

function sameRecord(
	actual: Readonly<Record<string, FlagValue>>,
	expected: Readonly<Record<string, FlagValue>> | undefined,
): boolean {
	return (
		expected !== undefined &&
		Object.keys(actual).length === Object.keys(expected).length &&
		Object.entries(expected).every(
			([name, value]) =>
				Object.hasOwn(actual, name) && sameJson(actual[name], value),
		)
	);
}

function subjectIdentity(subjectKey: string, tenant?: string): string {
	return JSON.stringify([tenant ?? null, subjectKey]);
}

function hashSubject(subjectKey: string, tenant?: string): string {
	return createHash("sha256")
		.update(
			tenant === undefined ? subjectKey : subjectIdentity(subjectKey, tenant),
		)
		.digest("hex")
		.slice(0, 16);
}

export function createExperimentId(): string {
	return `exp_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}
