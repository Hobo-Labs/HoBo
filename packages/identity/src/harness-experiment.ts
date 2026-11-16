/**
 * OpenExperiment port (hobo:experiment) — assignment, exposure, tracking hooks.
 * Heavy statistical analysis remains behind pluggable adapters (not in core).
 */

import { createHash, randomUUID } from "node:crypto";
import { must } from "@hobo/core/total-access";
import {
	bucket,
	type FeatureFlagStore,
	type FlagEvalContext,
} from "./feature-flag-store.js";
import type { JsonObject } from "./json.js";

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
	assignedAt: string;
}>;

/**
 * Built-in experiment engine: sticky assignment + exposure tracking + OTEL-shaped hooks.
 */
export class OpenExperimentEngine {
	readonly events: ExperimentEvent[] = [];
	private seq = 0;
	private readonly defs = new Map<string, ExperimentDefinition>();
	private readonly assignments = new Map<string, ExperimentAssignment>();
	private readonly now: () => string;
	private readonly store: FeatureFlagStore;
	/** OTEL-shaped emission hook (no hard OTEL dependency). */
	private readonly emitOtel?: (span: {
		readonly name: string;
		readonly attributes: Readonly<Record<string, string | number | boolean>>;
	}) => void;

	constructor(options: {
		readonly store: FeatureFlagStore;
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

	define(def: ExperimentDefinition): ExperimentDefinition {
		const frozen = Object.freeze({
			name: def.name,
			flag: def.flag,
			variants: Object.freeze([...def.variants]),
			...(def.allocation !== undefined
				? { allocation: Object.freeze({ ...def.allocation }) }
				: undefined),
			...(def.metrics !== undefined
				? { metrics: Object.freeze([...def.metrics]) }
				: undefined),
		});
		this.defs.set(def.name, frozen);
		// Ensure flag exists with variants
		const existing = this.store.get(def.flag);
		const variants: Record<string, boolean | string> = {};
		for (const v of def.variants) {
			variants[v] = v === "treatment" || v === "on" ? true : v;
		}
		this.store.define({
			key: def.flag,
			variants,
			defaultVariant: def.variants[0] ?? "control",
			defaultValue: false,
			percentage: existing?.percentage ?? 100,
			enabled: true,
			state: "ENABLED",
			metadata: { experiment: def.name },
		});
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
		const mapKey = `${experimentName}::${subjectKey}`;
		const existing = this.assignments.get(mapKey);
		if (existing) return existing;

		const variant = pickVariant(subjectKey, def);
		const t = this.now();
		const assignment: ExperimentAssignment = Object.freeze({
			experiment: experimentName,
			flag: def.flag,
			variant,
			subjectKey,
			assignedAt: t,
		});
		this.assignments.set(mapKey, assignment);
		this.emit(EXPERIMENT_EVENTS.Assigned, {
			experiment: experimentName,
			flag: def.flag,
			variant,
			subjectKeyHash: hashSubject(subjectKey),
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
	expose(experimentName: string, context: FlagEvalContext): void {
		const assignment = this.assign(experimentName, context);
		this.emit(EXPERIMENT_EVENTS.Exposed, {
			experiment: experimentName,
			variant: assignment.variant,
			subjectKeyHash: hashSubject(context.targetingKey),
		});
		this.emitOtel?.({
			name: "experiment.expose",
			attributes: {
				"experiment.name": experimentName,
				"experiment.variant": assignment.variant,
			},
		});
	}

	/** Evaluate flag and treat as exposure (common path). */
	evaluateAndExpose(
		experimentName: string,
		context: FlagEvalContext,
	): ExperimentAssignment {
		const assignment = this.assign(experimentName, context);
		// Align flag sticky evaluation
		this.store.evaluate(assignment.flag, context, false);
		this.expose(experimentName, context);
		return assignment;
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
	): ExperimentAssignment | undefined {
		return this.assignments.get(`${experimentName}::${subjectKey}`);
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

function pickVariant(subjectKey: string, def: ExperimentDefinition): string {
	const weights = def.allocation?.weights;
	if (weights && Object.keys(weights).length > 0) {
		const b = bucket(subjectKey);
		let acc = 0;
		for (const [name, w] of Object.entries(weights)) {
			acc += Number(w) || 0;
			if (b < acc) return name;
		}
	}
	const variants = def.variants;
	if (variants.length === 0) return "control";
	const idx = bucket(subjectKey) % variants.length;
	return must(variants[idx]);
}

function hashSubject(subjectKey: string): string {
	return createHash("sha256").update(subjectKey).digest("hex").slice(0, 16);
}

export function createExperimentId(): string {
	return `exp_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}
