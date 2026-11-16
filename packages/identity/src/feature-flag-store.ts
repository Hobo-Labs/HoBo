/**
 * Built-in OpenFeature-compatible feature-flag store (ADR-0044 / ADR-0083).
 * Single store for continuous identity cohorts + general application flags.
 * No parallel flag system. Evaluation is pure over (ruleset@seq, context).
 */

import { createHash, randomUUID } from "node:crypto";
import { must } from "@hobo/core/total-access";
import { isJsonBoolean, type JsonObject } from "./json.js";

// public-contract: flag event schema version.
export const FLAG_EVENT_SCHEMA_VERSION = "hobo.flag-events/v1" as const;

// public-contract: hobo:feature-flag port id.
export const FEATURE_FLAG_PORT = "hobo:feature-flag" as const;

export const FLAG_EVENTS = Object.freeze({
	Defined: "flag.Defined",
	Changed: "flag.Changed",
	Evaluated: "flag.Evaluated",
	Archived: "flag.Archived",
	KillSwitch: "flag.KillSwitch",
} as const);

export type FlagEventType = (typeof FLAG_EVENTS)[keyof typeof FLAG_EVENTS];

export type FlagEvent = Readonly<{
	id: string;
	type: FlagEventType;
	schemaVersion: typeof FLAG_EVENT_SCHEMA_VERSION;
	seq: number;
	time: string;
	data: JsonObject;
}>;

export type FlagValue = boolean | string | number | JsonObject;

export type FlagState = "ENABLED" | "DISABLED";

export type FractionalVariant = Readonly<Record<string, number>>;

export type FlagTargeting = Readonly<{
	/** Sticky hash key path(s) from EvaluationContext (e.g. identity.userId). */
	fractional?: Readonly<{
		key: readonly string[];
		variants: readonly FractionalVariant[];
	}>;
	/** Explicit sticky key attribute name when not using fractional.key. */
	stickyKey?: string;
	/** Attribute equals rules (simple). */
	rules?: readonly Readonly<{
		attribute: string;
		equals: string;
		variant: string;
	}>[];
}>;

export type FlagDefinition = Readonly<{
	key: string;
	/** Boolean default (migration + simple flags). */
	defaultValue: boolean;
	/** 0–100 progressive ramp for boolean treatment (OpenFeature percentage). */
	percentage: number;
	enabled: boolean;
	state: FlagState;
	/** Named variants (OpenFeature). Values are the resolved flag values. */
	variants: Readonly<Record<string, FlagValue>>;
	defaultVariant: string;
	targeting?: FlagTargeting;
	/** Fast-path kill: always return defaultVariant and bump invalidation. */
	killSwitch: boolean;
	/** Optional migration binding (continuous identity). */
	migrationId?: string;
	/** Auto-abort when dual oracle fails (migration flags). */
	autoAbortOnDualFailure: boolean;
	metadata: Readonly<Record<string, string>>;
	seq: number;
	updatedAt: string;
}>;

export type FlagEvaluation = Readonly<{
	flagKey: string;
	value: boolean;
	reason:
		| "targeting-match"
		| "default"
		| "disabled"
		| "fail-safe-default"
		| "kill-switch"
		| "split"
		| "static";
	variant: string;
	rulesetSeq: number;
	/** OpenFeature-compatible evaluation context hash (no PII). */
	contextDigest: string;
}>;

export type FlagEvalContext = Readonly<{
	/** PrincipalRef or opaque targeting key. */
	targetingKey: string;
	tenant?: string;
	/** Flat attributes for targeting rules (identity.userId, env, camp, …). */
	attributes?: Readonly<Record<string, string>>;
}>;

export type DetailEvaluation<T = FlagValue> = Readonly<{
	flagKey: string;
	value: T;
	variant: string;
	reason: FlagEvaluation["reason"];
	rulesetSeq: number;
	contextDigest: string;
}>;

/**
 * In-process deterministic flag store.
 * Continuous identity migration and app flags share this store (ADR-0132 / ADR-0044).
 */
export class FeatureFlagStore {
	private seq = 0;
	private invalidationSeq = 0;
	private readonly flags = new Map<string, FlagDefinition>();
	readonly events: FlagEvent[] = [];
	private readonly now: () => string;
	/** Optional metering hook (UsageEvent-shaped metadata only). */
	private readonly onEvaluate?: (detail: DetailEvaluation) => void;
	/**
	 * Sample rate for flag.Evaluated events (0–1). Kill-switch / targeting
	 * failures still emit when forceEmitReasons match. Default 0.01 (1%).
	 */
	private readonly sampleRate: number;

	constructor(options?: {
		readonly now?: () => string;
		readonly onEvaluate?: (detail: DetailEvaluation) => void;
		/** 0–1; default 0.01. Use 1 in tests that assert every evaluation. */
		readonly sampleRate?: number;
	}) {
		this.now = options?.now ?? (() => new Date().toISOString());
		this.onEvaluate = options?.onEvaluate;
		const rate = options?.sampleRate ?? 0.01;
		this.sampleRate = Number.isFinite(rate)
			? Math.max(0, Math.min(1, rate))
			: 0.01;
	}

	/** Ruleset generation for kill-switch fast path / reactive invalidation. */
	get rulesetSeq(): number {
		return Math.max(this.seq, this.invalidationSeq);
	}

	list(): readonly FlagDefinition[] {
		return Object.freeze([...this.flags.values()]);
	}

	get(key: string): FlagDefinition | undefined {
		return this.flags.get(key);
	}

	/**
	 * Define or replace a flag (emits flag.Defined or flag.Changed).
	 * Backward compatible with migration-harness fields.
	 */
	define(input: {
		readonly key: string;
		readonly defaultValue?: boolean;
		readonly percentage?: number;
		readonly enabled?: boolean;
		readonly state?: FlagState;
		readonly variants?: Readonly<Record<string, FlagValue>>;
		readonly defaultVariant?: string;
		readonly targeting?: FlagTargeting;
		readonly killSwitch?: boolean;
		readonly migrationId?: string;
		readonly autoAbortOnDualFailure?: boolean;
		readonly metadata?: Readonly<Record<string, string>>;
	}): FlagDefinition {
		const existing = this.flags.get(input.key);
		const t = this.now();
		const nextSeq = this.nextSeq();
		const enabled =
			input.enabled ??
			(input.state !== undefined
				? input.state === "ENABLED"
				: (existing?.enabled ?? true));
		const state: FlagState = input.state ?? (enabled ? "ENABLED" : "DISABLED");
		const defaultValue = input.defaultValue ?? existing?.defaultValue ?? false;
		const variants =
			input.variants ??
			existing?.variants ??
			Object.freeze({
				// SAFETY: assertion to ` FlagValue, //` is required at this boundary.
				control: false as FlagValue,
				// SAFETY: assertion to `FlagValue, //` is required at this boundary.
				treatment: true as FlagValue,
				// SAFETY: assertion to `FlagValue, //` is required at this boundary.
				on: true as FlagValue,
				// SAFETY: assertion to ` FlagValue, });` is required at this boundary.
				off: false as FlagValue,
			});
		const defaultVariant =
			input.defaultVariant ??
			existing?.defaultVariant ??
			(defaultValue ? "treatment" : "control");

		const def: FlagDefinition = Object.freeze({
			key: input.key,
			defaultValue,
			percentage: clampPercent(
				input.percentage ?? existing?.percentage ?? (enabled ? 100 : 0),
			),
			enabled: state === "ENABLED" && enabled,
			state,
			variants: Object.freeze({ ...variants }),
			defaultVariant,
			...(input.targeting !== undefined
				? { targeting: freezeTargeting(input.targeting) }
				: existing?.targeting !== undefined
					? { targeting: existing.targeting }
					: undefined),
			killSwitch: input.killSwitch ?? existing?.killSwitch ?? false,
			...(input.migrationId !== undefined
				? { migrationId: input.migrationId }
				: existing?.migrationId !== undefined
					? { migrationId: existing.migrationId }
					: undefined),
			autoAbortOnDualFailure:
				input.autoAbortOnDualFailure ??
				existing?.autoAbortOnDualFailure ??
				false,
			metadata: Object.freeze({
				...existing?.metadata,
				...input.metadata,
			}),
			seq: nextSeq,
			updatedAt: t,
		});
		this.flags.set(input.key, def);
		const type = existing ? FLAG_EVENTS.Changed : FLAG_EVENTS.Defined;
		this.events.push(
			Object.freeze({
				id: `evt-${type}-${input.key}-${nextSeq}`,
				type,
				schemaVersion: FLAG_EVENT_SCHEMA_VERSION,
				seq: nextSeq,
				time: t,
				data: Object.freeze({
					key: def.key,
					defaultValue: def.defaultValue,
					percentage: def.percentage,
					enabled: def.enabled,
					state: def.state,
					defaultVariant: def.defaultVariant,
					killSwitch: def.killSwitch,
					...(def.migrationId !== undefined
						? { migrationId: def.migrationId }
						: undefined),
					autoAbortOnDualFailure: def.autoAbortOnDualFailure,
				}),
			}),
		);
		return def;
	}

	/** Load Bindle feature declarations into the store. */
	loadDefinitions(
		defs: readonly FlagDefinitionInput[],
	): readonly FlagDefinition[] {
		return Object.freeze(defs.map((d) => this.define(d)));
	}

	/**
	 * OpenFeature-shaped boolean evaluation.
	 * Deterministic: sticky hash of targeting key into 0–99 vs percentage / fractional.
	 */
	evaluateBoolean(
		key: string,
		context: FlagEvalContext,
		defaultValue = false,
	): FlagEvaluation {
		const detail = this.evaluate(key, context, defaultValue);
		const boolVal = isJsonBoolean(detail.value)
			? detail.value
			: Boolean(detail.value);
		const evaluation: FlagEvaluation = Object.freeze({
			flagKey: detail.flagKey,
			value: boolVal,
			reason: detail.reason,
			variant: detail.variant,
			rulesetSeq: detail.rulesetSeq,
			contextDigest: detail.contextDigest,
		});
		return evaluation;
	}

	/** OpenFeature get*Details-shaped evaluation for any flag type. */
	evaluate(
		key: string,
		context: FlagEvalContext,
		defaultValue: FlagValue = false,
	): DetailEvaluation {
		const def = this.flags.get(key);
		const contextDigest = digestContext(context);

		if (!def || def.state === "DISABLED" || !def.enabled) {
			const evaluation: DetailEvaluation = Object.freeze({
				flagKey: key,
				value: defaultValue,
				variant: isJsonBoolean(defaultValue)
					? defaultValue
						? "on"
						: "off"
					: "default",
				reason: def ? ("disabled" as const) : ("fail-safe-default" as const),
				rulesetSeq: def?.seq ?? 0,
				contextDigest,
			});
			this.sampleEval(evaluation);
			return evaluation;
		}

		// Multi-tenant isolation: tenant-bound flags fail closed unless context.tenant matches.
		// Missing context.tenant is a mismatch (fail closed), not a pass-through.
		const flagTenant = def.metadata.tenant ?? def.metadata.appTenant;
		if (
			flagTenant !== undefined &&
			flagTenant !== "" &&
			flagTenant !== context.tenant
		) {
			const evaluation: DetailEvaluation = Object.freeze({
				flagKey: key,
				value: defaultValue,
				variant: "default",
				reason: "fail-safe-default",
				rulesetSeq: def.seq,
				contextDigest,
			});
			this.sampleEval(evaluation);
			return evaluation;
		}

		if (def.killSwitch) {
			const variant = def.defaultVariant;
			const value = def.variants[variant] ?? def.defaultValue;
			const evaluation: DetailEvaluation = Object.freeze({
				flagKey: key,
				value,
				variant,
				reason: "kill-switch",
				rulesetSeq: this.rulesetSeq,
				contextDigest,
			});
			this.sampleEval(evaluation);
			return evaluation;
		}

		// Attribute rules first
		if (def.targeting?.rules) {
			const attrs = context.attributes ?? {};
			for (const rule of def.targeting.rules) {
				if (attrs[rule.attribute] === rule.equals) {
					const value = def.variants[rule.variant] ?? def.defaultValue;
					const evaluation: DetailEvaluation = Object.freeze({
						flagKey: key,
						value,
						variant: rule.variant,
						reason: "targeting-match",
						rulesetSeq: def.seq,
						contextDigest,
					});
					this.sampleEval(evaluation);
					return evaluation;
				}
			}
		}

		// Fractional multi-variant split
		if (def.targeting?.fractional) {
			const sticky = stickyKeyFromContext(
				context,
				def.targeting.fractional.key,
				def.targeting.stickyKey,
			);
			const variant = pickFractionalVariant(
				sticky,
				def.targeting.fractional.variants,
			);
			const value = def.variants[variant] ?? def.defaultValue;
			const evaluation: DetailEvaluation = Object.freeze({
				flagKey: key,
				value,
				variant,
				reason: "split",
				rulesetSeq: def.seq,
				contextDigest,
			});
			this.sampleEval(evaluation);
			return evaluation;
		}

		// Boolean percentage ramp (migration + simple canary)
		const sticky = stickyKeyFromContext(
			context,
			def.targeting?.stickyKey ? [def.targeting.stickyKey] : ["targetingKey"],
			def.targeting?.stickyKey,
		);
		const inCohort = bucket(sticky) < def.percentage;
		if (inCohort) {
			const treatment =
				def.variants.treatment !== undefined
					? "treatment"
					: def.variants.on !== undefined
						? "on"
						: def.defaultVariant;
			const value = def.variants[treatment] ?? true;
			const evaluation: DetailEvaluation = Object.freeze({
				flagKey: key,
				value,
				variant: treatment,
				reason: "targeting-match",
				rulesetSeq: def.seq,
				contextDigest,
			});
			this.sampleEval(evaluation);
			return evaluation;
		}

		const control =
			def.variants.control !== undefined
				? "control"
				: def.variants.off !== undefined
					? "off"
					: def.defaultVariant;
		const value = def.variants[control] ?? def.defaultValue;
		const evaluation: DetailEvaluation = Object.freeze({
			flagKey: key,
			value,
			variant: control,
			reason: "default",
			rulesetSeq: def.seq,
			contextDigest,
		});
		this.sampleEval(evaluation);
		return evaluation;
	}

	/**
	 * Kill-switch: force defaultVariant and bump invalidation seq (fast-path).
	 * Emits flag.KillSwitch + flag.Changed.
	 */
	activateKillSwitch(
		key: string,
		actor = "system",
	): FlagDefinition | undefined {
		const existing = this.flags.get(key);
		if (!existing) return undefined;
		this.invalidationSeq = this.nextSeq();
		const def = this.define({
			key,
			killSwitch: true,
			enabled: true,
			state: "ENABLED",
			percentage: 0,
			defaultVariant: existing.defaultVariant,
			variants: existing.variants,
			defaultValue: existing.defaultValue,
			...(existing.migrationId !== undefined
				? { migrationId: existing.migrationId }
				: undefined),
			metadata: { ...existing.metadata, killSwitchActor: actor },
		});
		this.events.push(
			Object.freeze({
				id: `evt-${FLAG_EVENTS.KillSwitch}-${key}-${this.seq}`,
				type: FLAG_EVENTS.KillSwitch,
				schemaVersion: FLAG_EVENT_SCHEMA_VERSION,
				seq: this.seq,
				time: this.now(),
				data: Object.freeze({
					key,
					actor,
					invalidationSeq: this.invalidationSeq,
				}),
			}),
		);
		return def;
	}

	clearKillSwitch(key: string): FlagDefinition | undefined {
		const existing = this.flags.get(key);
		if (!existing) return undefined;
		return this.define({
			key,
			killSwitch: false,
			percentage: existing.percentage || 100,
			enabled: existing.enabled,
			state: existing.state,
			defaultVariant: existing.defaultVariant,
			variants: existing.variants,
			defaultValue: existing.defaultValue,
			...(existing.migrationId !== undefined
				? { migrationId: existing.migrationId }
				: undefined),
		});
	}

	archive(key: string): void {
		const def = this.flags.get(key);
		if (!def) return;
		this.flags.delete(key);
		const seq = this.nextSeq();
		this.events.push(
			Object.freeze({
				id: `evt-${FLAG_EVENTS.Archived}-${key}-${seq}`,
				type: FLAG_EVENTS.Archived,
				schemaVersion: FLAG_EVENT_SCHEMA_VERSION,
				seq,
				time: this.now(),
				data: Object.freeze({ key }),
			}),
		);
	}

	private sampleEval(evaluation: DetailEvaluation): void {
		// Metering always sees the evaluation (high-volume, low-privilege).
		this.onEvaluate?.(evaluation);
		// Always record kill-switch and security-relevant reasons.
		const forceEmit =
			evaluation.reason === "kill-switch" ||
			evaluation.reason === "fail-safe-default";
		if (!forceEmit && this.sampleRate < 1) {
			// Deterministic sample from context digest + flag (replay-safe).
			const sampleKey = `${evaluation.flagKey}:${evaluation.contextDigest}`;
			const bucket01 = bucket(sampleKey) / 100;
			if (bucket01 >= this.sampleRate) return;
		}
		const seq = this.nextSeq();
		this.events.push(
			Object.freeze({
				id: `evt-${FLAG_EVENTS.Evaluated}-${evaluation.flagKey}-${seq}`,
				type: FLAG_EVENTS.Evaluated,
				schemaVersion: FLAG_EVENT_SCHEMA_VERSION,
				seq,
				time: this.now(),
				data: Object.freeze({ ...evaluation }),
			}),
		);
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}
}

export type FlagDefinitionInput = Parameters<FeatureFlagStore["define"]>[0];

function freezeTargeting(t: FlagTargeting): FlagTargeting {
	return Object.freeze({
		...(t.fractional !== undefined
			? {
					fractional: Object.freeze({
						key: Object.freeze([...t.fractional.key]),
						variants: Object.freeze(
							t.fractional.variants.map((v) => Object.freeze({ ...v })),
						),
					}),
				}
			: undefined),
		...(t.stickyKey !== undefined ? { stickyKey: t.stickyKey } : undefined),
		...(t.rules !== undefined
			? {
					rules: Object.freeze(t.rules.map((r) => Object.freeze({ ...r }))),
				}
			: undefined),
	});
}

function clampPercent(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.floor(n)));
}

export function bucket(targetingKey: string): number {
	let h = 0;
	for (let i = 0; i < targetingKey.length; i++) {
		h = (h * 31 + targetingKey.charCodeAt(i)) >>> 0;
	}
	return h % 100;
}

function digestContext(context: FlagEvalContext): string {
	const attrs = context.attributes
		? Object.keys(context.attributes)
				.sort()
				.map((k) => `${k}=${must(context.attributes)[k]}`)
				.join("&")
		: "";
	return `sha256:${createHash("sha256")
		.update(`${context.tenant ?? ""}:${context.targetingKey}:${attrs}`)
		.digest("hex")
		.slice(0, 16)}`;
}

function stickyKeyFromContext(
	context: FlagEvalContext,
	keys: readonly string[],
	stickyKey?: string,
): string {
	const attrs = context.attributes ?? {};
	if (stickyKey && attrs[stickyKey]) return must(attrs[stickyKey]);
	for (const k of keys) {
		if (k === "targetingKey") return context.targetingKey;
		const parts = k.split(".");
		const leaf = must(parts[parts.length - 1]);
		if (attrs[k]) return must(attrs[k]);
		if (attrs[leaf]) return must(attrs[leaf]);
	}
	return context.targetingKey;
}

/**
 * Pick variant from fractional weights (sum to 100 recommended).
 * Deterministic given sticky key.
 */
export function pickFractionalVariant(
	sticky: string,
	variants: readonly FractionalVariant[],
): string {
	const b = bucket(sticky);
	let acc = 0;
	for (const row of variants) {
		const [[name, weight] = ["control", 0]] = Object.entries(row);
		acc += Number(weight) || 0;
		if (b < acc) return name;
	}
	const last = variants[variants.length - 1];
	if (last) {
		const keys = Object.keys(last);
		if (keys[0]) return keys[0];
	}
	return "control";
}

/** Stable flag key for a migration cohort (OpenFeature key). */
export function migrationCohortFlagKey(migrationId: string): string {
	return `identity-migration.${migrationId}`;
}

export function createMigrationFlagId(): string {
	return `flag_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
