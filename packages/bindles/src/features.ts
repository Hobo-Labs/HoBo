/**
 * Bindle IfC surface for features, experiments, and rollouts (ADR-0044 / ADR-0083).
 * Schema is the committed layout; runtime values live in FeatureFlagStore.
 */

import { createHash } from "node:crypto";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: bindle features schema version.
export const BINDLE_FEATURES_SCHEMA = "hobo.bindle-features/v1" as const;

export type FeatureState = "ENABLED" | "DISABLED";

export type FeatureFlagSpec = Readonly<{
	state?: FeatureState;
	variants?: Readonly<Record<string, boolean | string | number>>;
	defaultVariant?: string;
	targeting?: Readonly<{
		fractional?: Readonly<{
			key: readonly string[];
			variants: readonly Readonly<Record<string, number>>[];
		}>;
		stickyKey?: string;
		rules?: readonly Readonly<{
			attribute: string;
			equals: string;
			variant: string;
		}>[];
	}>;
	/** 0–100 boolean ramp when fractional not set. */
	percentage?: number;
	killSwitch?: boolean;
	metadata?: Readonly<Record<string, string>>;
}>;

export type FeaturesDeclaration = Readonly<{
	schemaVersion: typeof BINDLE_FEATURES_SCHEMA;
	features: Readonly<Record<string, FeatureFlagSpec>>;
	contentHash: `sha256:${string}`;
}>;

export type ExperimentSpec = Readonly<{
	flag: string;
	variants: readonly string[];
	allocation?: Readonly<{
		weights?: Readonly<Record<string, number>>;
	}>;
	metrics?: readonly string[];
}>;

export type ExperimentDeclaration = Readonly<{
	schemaVersion: typeof BINDLE_FEATURES_SCHEMA;
	name: string;
	spec: ExperimentSpec;
	contentHash: `sha256:${string}`;
}>;

export type RolloutStageSpec = Readonly<{
	percent: number;
	duration?: string;
	analysis?: Readonly<{
		slo?: string;
		golden?: boolean;
		guardrailMetric?: string;
	}>;
}>;

export type RolloutSpec = Readonly<{
	name: string;
	flag: string;
	stages: readonly RolloutStageSpec[];
	traffic?: "flag-only" | "gateway-weighted";
	autoRollback?: boolean;
}>;

export type RolloutDeclaration = Readonly<{
	schemaVersion: typeof BINDLE_FEATURES_SCHEMA;
	spec: RolloutSpec;
	contentHash: `sha256:${string}`;
}>;

/**
 * Declare application feature flags in a Bindle (IfC).
 * Zero required config for a simple boolean: features({ "x": {} }).
 */
export function features(
	defs: Readonly<Record<string, FeatureFlagSpec>>,
): FeaturesDeclaration {
	const featuresMap: Record<string, FeatureFlagSpec> = {};
	for (const [key, spec] of Object.entries(defs)) {
		if (!key) throw new TypeError("feature key required");
		featuresMap[key] = Object.freeze(parseFeatureSpec(spec));
	}
	const body = {
		schemaVersion: BINDLE_FEATURES_SCHEMA,
		features: featuresMap,
	};
	const contentHash = `sha256:${createHash("sha256")
		.update(stableStringify(cloneAsJson(body)))
		.digest("hex")}` as const;
	return Object.freeze({
		schemaVersion: BINDLE_FEATURES_SCHEMA,
		features: Object.freeze(featuresMap),
		contentHash,
	});
}

export function experiment(
	name: string,
	spec: ExperimentSpec,
): ExperimentDeclaration {
	if (!name) throw new TypeError("experiment name required");
	if (!spec.flag) throw new TypeError("experiment.flag required");
	if (!spec.variants?.length) {
		throw new TypeError("experiment.variants required");
	}
	const frozen: ExperimentSpec = Object.freeze({
		flag: spec.flag,
		variants: Object.freeze([...spec.variants]),
		...(spec.allocation !== undefined
			? { allocation: Object.freeze({ ...spec.allocation }) }
			: undefined),
		...(spec.metrics !== undefined
			? { metrics: Object.freeze([...spec.metrics]) }
			: undefined),
	});
	const body = { schemaVersion: BINDLE_FEATURES_SCHEMA, name, spec: frozen };
	const contentHash = `sha256:${createHash("sha256")
		.update(stableStringify(cloneAsJson(body)))
		.digest("hex")}` as const;
	return Object.freeze({
		schemaVersion: BINDLE_FEATURES_SCHEMA,
		name,
		spec: frozen,
		contentHash,
	});
}

export function rollout(spec: RolloutSpec): RolloutDeclaration {
	if (!spec.name || !spec.flag) {
		throw new TypeError("rollout requires name and flag");
	}
	if (!spec.stages?.length) {
		throw new TypeError("rollout.stages required");
	}
	const frozen: RolloutSpec = Object.freeze({
		name: spec.name,
		flag: spec.flag,
		stages: Object.freeze(
			spec.stages.map((s) =>
				Object.freeze({
					percent: s.percent,
					...(s.duration !== undefined ? { duration: s.duration } : undefined),
					...(s.analysis !== undefined
						? { analysis: Object.freeze({ ...s.analysis }) }
						: undefined),
				}),
			),
		),
		traffic: spec.traffic ?? "flag-only",
		autoRollback: spec.autoRollback !== false,
	});
	const body = { schemaVersion: BINDLE_FEATURES_SCHEMA, spec: frozen };
	const contentHash = `sha256:${createHash("sha256")
		.update(stableStringify(cloneAsJson(body)))
		.digest("hex")}` as const;
	return Object.freeze({
		schemaVersion: BINDLE_FEATURES_SCHEMA,
		spec: frozen,
		contentHash,
	});
}

/**
 * Convert Bindle features declaration into FeatureFlagStore.define inputs.
 */
export function featureSpecsToStoreInputs(decl: FeaturesDeclaration): readonly {
	readonly key: string;
	readonly state?: FeatureState;
	readonly percentage?: number;
	readonly defaultValue?: boolean;
	readonly variants?: Readonly<Record<string, boolean | string | number>>;
	readonly defaultVariant?: string;
	readonly killSwitch?: boolean;
	readonly metadata?: Readonly<Record<string, string>>;
	readonly targeting?: FeatureFlagSpec["targeting"];
}[] {
	return Object.freeze(
		Object.entries(decl.features).map(([key, spec]) => {
			const defaultVariant = spec.defaultVariant ?? "control";
			const variants = spec.variants ?? {
				control: false,
				treatment: true,
			};
			const defaultVariantValue = variants[defaultVariant];
			const defaultValue = isJsonBoolean(defaultVariantValue)
				? defaultVariantValue
				: false;
			return Object.freeze({
				key,
				state: spec.state ?? "ENABLED",
				percentage: spec.percentage ?? 100,
				defaultValue,
				variants,
				defaultVariant,
				killSwitch: spec.killSwitch === true,
				...(spec.metadata !== undefined
					? { metadata: spec.metadata }
					: undefined),
				...(spec.targeting !== undefined
					? { targeting: spec.targeting }
					: undefined),
			});
		}),
	);
}

function parseFeatureSpec(spec: FeatureFlagSpec): FeatureFlagSpec {
	return {
		state: spec.state ?? "ENABLED",
		...(spec.variants !== undefined
			? { variants: Object.freeze({ ...spec.variants }) }
			: undefined),
		...(spec.defaultVariant !== undefined
			? { defaultVariant: spec.defaultVariant }
			: undefined),
		...(spec.targeting !== undefined
			? { targeting: spec.targeting }
			: undefined),
		...(spec.percentage !== undefined
			? { percentage: spec.percentage }
			: undefined),
		killSwitch: spec.killSwitch === true,
		...(spec.metadata !== undefined
			? { metadata: Object.freeze({ ...spec.metadata }) }
			: undefined),
	};
}

function stableStringify(value: JsonValue): string {
	if (value === null || !isJsonObject(value)) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = value as JsonObject;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k] ?? null)}`).join(",")}}`;
}
