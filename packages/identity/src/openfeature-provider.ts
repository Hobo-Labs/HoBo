/**
 * OpenFeature-shaped provider over FeatureFlagStore (ADR-0044).
 * Application code uses this API only — never vendor SDKs.
 * We implement the OpenFeature client surface natively (no hard npm dependency).
 */

import {
	createDevEvaluationContext,
	enrichEvaluationContext,
	type HoBoScopeAttributes,
} from "./evaluation-context.js";
import {
	type DetailEvaluation,
	FEATURE_FLAG_PORT,
	type FeatureFlagStore,
	type FlagEvalContext,
	type FlagValue,
} from "./feature-flag-store.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";

// public-contract: OpenFeature provider metadata.
export const HOBO_OPENFEATURE_PROVIDER_NAME = "hobo-feature-flag" as const;

export type OpenFeatureResolutionDetails<T> = Readonly<{
	value: T;
	variant?: string;
	reason?: string;
	flagKey: string;
	flagMetadata?: Readonly<Record<string, string>>;
}>;

/**
 * OpenFeature Provider-compatible evaluator.
 * Methods mirror OF boolean/string/number/object evaluation.
 */
export class HoboOpenFeatureProvider {
	readonly metadata = Object.freeze({
		name: HOBO_OPENFEATURE_PROVIDER_NAME,
		port: FEATURE_FLAG_PORT,
	});

	constructor(
		readonly store: FeatureFlagStore,
		private readonly staticScope: HoBoScopeAttributes = {},
	) {}

	/** Merge static Camp/Yard scope with per-call context. */
	resolveContext(
		evalCtx?: FlagEvalContext | HoBoScopeAttributes,
	): FlagEvalContext {
		if (evalCtx && "targetingKey" in evalCtx) {
			return enrichEvaluationContext(this.staticScope, evalCtx);
		}
		return enrichEvaluationContext({
			...this.staticScope,
			// SAFETY: assertion to `alCtx as HoBoScopeAttributes | undefined),` is required at this boundary.
			...(evalCtx as HoBoScopeAttributes | undefined),
		});
	}

	resolveBooleanEvaluation(
		flagKey: string,
		defaultValue: boolean,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): OpenFeatureResolutionDetails<boolean> {
		const ctx = this.resolveContext(context);
		const detail = this.store.evaluateBoolean(flagKey, ctx, defaultValue);
		return Object.freeze({
			value: detail.value,
			variant: detail.variant,
			reason: detail.reason,
			flagKey,
		});
	}

	resolveStringEvaluation(
		flagKey: string,
		defaultValue: string,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): OpenFeatureResolutionDetails<string> {
		const d = this.evaluateAs(flagKey, defaultValue, context);
		return Object.freeze({
			value: isJsonString(d.value) ? d.value : defaultValue,
			variant: d.variant,
			reason: d.reason,
			flagKey,
		});
	}

	resolveNumberEvaluation(
		flagKey: string,
		defaultValue: number,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): OpenFeatureResolutionDetails<number> {
		const d = this.evaluateAs(flagKey, defaultValue, context);
		return Object.freeze({
			value: isJsonNumber(d.value) ? d.value : defaultValue,
			variant: d.variant,
			reason: d.reason,
			flagKey,
		});
	}

	resolveObjectEvaluation(
		flagKey: string,
		defaultValue: JsonObject,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): OpenFeatureResolutionDetails<JsonObject> {
		const d = this.evaluateAs(flagKey, defaultValue, context);
		const value =
			d.value !== null && isJsonObject(d.value) && !Array.isArray(d.value)
				? d.value
				: defaultValue;
		return Object.freeze({
			value,
			variant: d.variant,
			reason: d.reason,
			flagKey,
		});
	}

	private evaluateAs(
		flagKey: string,
		defaultValue: FlagValue,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): DetailEvaluation {
		return this.store.evaluate(
			flagKey,
			this.resolveContext(context),
			defaultValue,
		);
	}
}

/**
 * Thin client bootstrap — the only app-facing entry besides OpenFeature provider.
 * Zero config for local: uses store + dev fixtures when no scope provided.
 */
export class HoboFeatureClient {
	readonly provider: HoboOpenFeatureProvider;

	constructor(store: FeatureFlagStore, scope: HoBoScopeAttributes = {}) {
		this.provider = new HoboOpenFeatureProvider(store, scope);
	}

	getBooleanValue(
		flagKey: string,
		defaultValue = false,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): boolean {
		return this.provider.resolveBooleanEvaluation(
			flagKey,
			defaultValue,
			context,
		).value;
	}

	getStringValue(
		flagKey: string,
		defaultValue = "",
		context?: FlagEvalContext | HoBoScopeAttributes,
	): string {
		return this.provider.resolveStringEvaluation(flagKey, defaultValue, context)
			.value;
	}

	getNumberValue(
		flagKey: string,
		defaultValue = 0,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): number {
		return this.provider.resolveNumberEvaluation(flagKey, defaultValue, context)
			.value;
	}

	getObjectValue(
		flagKey: string,
		defaultValue: JsonObject = {},
		context?: FlagEvalContext | HoBoScopeAttributes,
	): JsonObject {
		return this.provider.resolveObjectEvaluation(flagKey, defaultValue, context)
			.value;
	}

	getBooleanDetails(
		flagKey: string,
		defaultValue = false,
		context?: FlagEvalContext | HoBoScopeAttributes,
	): OpenFeatureResolutionDetails<boolean> {
		return this.provider.resolveBooleanEvaluation(
			flagKey,
			defaultValue,
			context,
		);
	}
}

/** Offline local client for hobo dev (contract-asserted context). */
export function createLocalFeatureClient(
	store: FeatureFlagStore,
	dev?: { tenant?: string; userId?: string; env?: string },
): HoboFeatureClient {
	const ctx = createDevEvaluationContext(dev);
	return new HoboFeatureClient(store, {
		tenant: ctx.tenant,
		principal: { id: ctx.targetingKey, tenant: ctx.tenant },
		environment: ctx.attributes?.environment,
		env: ctx.attributes?.env,
		camp: ctx.attributes?.camp,
		yard: ctx.attributes?.yard,
	});
}
