/**
 * Ranked optional Harness backends (ADR-0027 mediation ladder).
 * Application code never imports vendor SDKs; residual adapters are mediated.
 *
 * - Feature flags: local-builtin (default) → camp-managed → ofrep-internal → external
 * - Delivery: builtin → optional CD residual (Argo/Flagger-shaped HTTP, no operator binary)
 * - Experiment: builtin analysis/export → optional analysis residual
 */

import { createHash } from "node:crypto";
import {
	FEATURE_FLAG_BACKEND_RANKS,
	type FeatureFlagBackendRank,
	type RankedBackend,
	selectFeatureFlagBackend,
} from "./feature-flag-ranking.js";
import {
	FeatureFlagStore as BuiltInStore,
	type DetailEvaluation,
	type FeatureFlagStore,
	type FlagEvalContext,
	type FlagValue,
} from "./feature-flag-store.js";
import type { RolloutPolicy, RolloutState } from "./harness-delivery.js";
import type {
	ExperimentAssignment,
	ExperimentDefinition,
	OpenExperimentEngine,
} from "./harness-experiment.js";
import type { JsonObject, JsonValue } from "./json.js";

// public-contract: OFREP residual adapter schema version.
export const OFREP_RESIDUAL_SCHEMA = "hobo.ofrep-residual/v1" as const;
// public-contract: delivery residual adapter schema version.
export const DELIVERY_ADAPTER_SCHEMA = "hobo.delivery-adapter/v1" as const;
// public-contract: experiment analysis/export schema version.
export const EXPERIMENT_ANALYSIS_SCHEMA =
	"hobo.experiment-analysis/v1" as const;

export type FetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	readonly json: () => Promise<JsonValue>;
	readonly text: () => Promise<string>;
}>;

// ---------------------------------------------------------------------------
// OpenFeature residual (OFREP-shaped HTTP) — mediated, never app-facing SDK
// ---------------------------------------------------------------------------

export interface OfrepResidualBackend {
	readonly id: "ofrep-internal" | "external";
	readonly schemaVersion: typeof OFREP_RESIDUAL_SCHEMA;
	evaluate(req: OfrepEvaluateRequest): Promise<DetailEvaluation>;
}

export type OfrepEvaluateRequest = Readonly<{
	flagKey: string;
	context: FlagEvalContext;
	defaultValue: FlagValue;
}>;

export type OfrepEvaluateResponse = Readonly<{
	value: FlagValue;
	variant?: string;
	reason?: string;
}>;

/**
 * Residual OFREP-style flag backend. Credentials stay in mediation; apps never
 * hold the URL or SDK. Fails closed to defaultValue on transport error.
 */
export function createOfrepResidualBackend(options: {
	readonly baseUrl: string;
	readonly fetchImpl?: FetchLike;
	readonly headers?: Readonly<Record<string, string>>;
}): OfrepResidualBackend {
	// SAFETY: assertion to `etch as FetchLike); const ba` is required at this boundary.
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	const base = options.baseUrl.replace(/\/$/, "");
	return {
		id: base.includes("ofrep") ? "ofrep-internal" : "external",
		schemaVersion: OFREP_RESIDUAL_SCHEMA,
		async evaluate(req) {
			try {
				const res = await fetchImpl(
					`${base}/ofrep/v1/evaluate/${encodeURIComponent(req.flagKey)}`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							...options.headers,
						},
						body: JSON.stringify({
							context: {
								targetingKey: req.context.targetingKey,
								tenant: req.context.tenant,
								attributes: req.context.attributes,
							},
						}),
					},
				);
				if (!res.ok) {
					return failSafe(req);
				}
				// SAFETY: assertion to `son()) as OfrepEvaluateResponse; return` is required at this boundary.
				const body = (await res.json()) as OfrepEvaluateResponse;
				return Object.freeze({
					flagKey: req.flagKey,
					value: body.value ?? req.defaultValue,
					variant: body.variant ?? "remote",
					reason:
						// SAFETY: assertion to `as DetailEvaluation["reason"]) ?? "target` is required at this boundary.
						(body.reason as DetailEvaluation["reason"]) ?? "targeting-match",
					rulesetSeq: 0,
					contextDigest: digestCtx(req.context),
				});
			} catch {
				return failSafe(req);
			}
		},
	};
}

function failSafe(req: OfrepEvaluateRequest): DetailEvaluation {
	return Object.freeze({
		flagKey: req.flagKey,
		value: req.defaultValue,
		variant: "default",
		reason: "fail-safe-default",
		rulesetSeq: 0,
		contextDigest: digestCtx(req.context),
	});
}

// ---------------------------------------------------------------------------
// Delivery residual (CDEvents / Argo-Flagger-shaped HTTP — no operator binary)
// ---------------------------------------------------------------------------

export type DeliveryAdapterKind = "builtin" | "argo-shaped" | "flagger-shaped";

export type DeliveryAdapter = Readonly<{
	kind: DeliveryAdapterKind;
	schemaVersion: typeof DELIVERY_ADAPTER_SCHEMA;
	/** Start a remote rollout representation (optional; no-op success when offline). */
	startRemote(policy: RolloutPolicy): Promise<{
		readonly accepted: boolean;
		readonly remoteId?: string;
		readonly note: string;
	}>;
	/** Mirror a local step to residual (optional). */
	mirrorStep(state: RolloutState): Promise<{ readonly mirrored: boolean }>;
}>;

/**
 * Built-in delivery residual: local-only, always available offline.
 */
export function createBuiltinDeliveryAdapter(): DeliveryAdapter {
	return Object.freeze({
		kind: "builtin",
		schemaVersion: DELIVERY_ADAPTER_SCHEMA,
		async startRemote(policy) {
			return Object.freeze({
				accepted: true,
				remoteId: `local:${policy.name}`,
				note: "builtin delivery; no remote CD operator",
			});
		},
		async mirrorStep() {
			return Object.freeze({ mirrored: true });
		},
	});
}

/**
 * Optional CD residual: Argo/Flagger-shaped HTTP webhook. Never embeds operators.
 * Fail-soft: reports accepted=false when transport fails (local engine remains source of truth).
 */
export function createCdResidualDeliveryAdapter(options: {
	readonly kind: "argo-shaped" | "flagger-shaped";
	readonly webhookUrl: string;
	readonly fetchImpl?: FetchLike;
}): DeliveryAdapter {
	// SAFETY: assertion to `ch as FetchLike); return Obj` is required at this boundary.
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	return Object.freeze({
		kind: options.kind,
		schemaVersion: DELIVERY_ADAPTER_SCHEMA,
		async startRemote(policy) {
			try {
				const res = await fetchImpl(options.webhookUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "io.argoproj.rollouts.step",
						spec: {
							flag: policy.flag,
							name: policy.name,
							stages: policy.stages,
							traffic: policy.traffic,
						},
					}),
				});
				return Object.freeze({
					accepted: res.ok,
					remoteId: res.ok ? `remote:${policy.name}` : undefined,
					note: res.ok
						? `${options.kind} residual accepted`
						: `${options.kind} residual rejected status=${res.status}`,
				});
			} catch (err) {
				return Object.freeze({
					accepted: false,
					note: `${options.kind} residual unavailable: ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		},
		async mirrorStep(state) {
			try {
				const res = await fetchImpl(options.webhookUrl, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "io.hobo.rollout.step",
						spec: {
							id: state.id,
							percent: state.percent,
							status: state.status,
						},
					}),
				});
				return Object.freeze({ mirrored: res.ok });
			} catch {
				return Object.freeze({ mirrored: false });
			}
		},
	});
}

export function selectDeliveryAdapter(
	candidates: readonly DeliveryAdapter[],
): DeliveryAdapter {
	const builtin = candidates.find((c) => c.kind === "builtin");
	if (builtin) return builtin;
	return candidates[0] ?? createBuiltinDeliveryAdapter();
}

// ---------------------------------------------------------------------------
// Experiment analysis + export (built-in baseline; heavy engines stay adapters)
// ---------------------------------------------------------------------------

export type ExperimentAnalysisResult = Readonly<{
	schemaVersion: typeof EXPERIMENT_ANALYSIS_SCHEMA;
	experiment: string;
	variantCounts: Readonly<Record<string, number>>;
	totalAssigned: number;
	totalExposed: number;
	/** Simple majority winner among variants with assignments; inconclusive if tie/empty. */
	verdict: "ship" | "do-not-ship" | "inconclusive";
	winningVariant?: string;
	exportPayload: Readonly<{
		format: "json";
		contentHash: `sha256:${string}`;
		body: JsonObject;
	}>;
}>;

export type ExperimentAnalysisPort = Readonly<{
	analyze(
		experiment: ExperimentDefinition,
		assignments: readonly ExperimentAssignment[],
		exposedCount: number,
	): ExperimentAnalysisResult;
}>;

/**
 * Built-in baseline analysis: count assignments, pick majority variant, export JSON.
 * Not a commercial stats engine — adapters (GrowthBook/Statsig) plug in here.
 */
export function createBuiltinExperimentAnalysis(): ExperimentAnalysisPort {
	// SAFETY: builtin analysis port is ExperimentAnalysisPort at this boundary.
	return Object.freeze({
		analyze(experiment, assignments, exposedCount) {
			const variantCounts: Record<string, number> = {};
			for (const v of experiment.variants) variantCounts[v] = 0;
			for (const a of assignments) {
				variantCounts[a.variant] = (variantCounts[a.variant] ?? 0) + 1;
			}
			const totalAssigned = assignments.length;
			let winningVariant: string | undefined;
			let max = -1;
			let tie = false;
			for (const [v, c] of Object.entries(variantCounts)) {
				if (c > max) {
					max = c;
					winningVariant = v;
					tie = false;
				} else if (c === max && c > 0) {
					tie = true;
				}
			}
			const verdict: ExperimentAnalysisResult["verdict"] =
				totalAssigned === 0 || tie || max <= 0
					? "inconclusive"
					: winningVariant === "treatment" || winningVariant === "on"
						? "ship"
						: winningVariant === "control" || winningVariant === "off"
							? "do-not-ship"
							: "inconclusive";
			const body = Object.freeze({
				experiment: experiment.name,
				flag: experiment.flag,
				variants: experiment.variants,
				variantCounts,
				totalAssigned,
				totalExposed: exposedCount,
				verdict,
				...(winningVariant !== undefined ? { winningVariant } : undefined),
				metrics: experiment.metrics ?? [],
			});
			const contentHash =
				`sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` as const;
			return Object.freeze({
				schemaVersion: EXPERIMENT_ANALYSIS_SCHEMA,
				experiment: experiment.name,
				variantCounts: Object.freeze({ ...variantCounts }),
				totalAssigned,
				totalExposed: exposedCount,
				verdict,
				...(winningVariant !== undefined && !tie
					? { winningVariant }
					: undefined),
				exportPayload: Object.freeze({
					format: "json" as const,
					contentHash,
					body,
				}),
			});
		},
	}) as never;
}

/**
 * Residual analysis adapter: posts assignment export to external endpoint.
 * On failure, falls back to built-in baseline (never blocks conclude path).
 */
export function createResidualExperimentAnalysis(options: {
	readonly endpointUrl: string;
	readonly fetchImpl?: FetchLike;
	readonly fallback?: ExperimentAnalysisPort;
}): ExperimentAnalysisPort {
	const fallback = options.fallback ?? createBuiltinExperimentAnalysis();
	// SAFETY: assertion to ` as FetchLike); return Objec` is required at this boundary.
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	return Object.freeze({
		analyze(experiment, assignments, exposedCount) {
			const baseline = fallback.analyze(experiment, assignments, exposedCount);
			// Fire-and-forget shape: sync analyze returns baseline; residual is optional enrich.
			void fetchImpl(options.endpointUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(baseline.exportPayload.body),
			}).catch(() => undefined);
			return baseline;
		},
	});
}

/** Analyze via experiment engine event log (assignments already sticky). */
export function analyzeExperimentFromEngine(
	engine: OpenExperimentEngine,
	experimentName: string,
	analysis: ExperimentAnalysisPort = createBuiltinExperimentAnalysis(),
): ExperimentAnalysisResult | null {
	const defs = engine.list();
	const def = defs.find((d) => d.name === experimentName);
	if (!def) return null;
	const assignments = engine.events
		.filter(
			(e) =>
				e.type === "experiment.Assigned" &&
				e.data.experiment === experimentName,
		)
		.map((e) =>
			Object.freeze({
				experiment: experimentName,
				flag: String(e.data.flag ?? def.flag),
				variant: String(e.data.variant ?? "control"),
				subjectKey: String(e.data.subjectKeyHash ?? "unknown"),
				assignedAt: e.time,
			}),
		);
	const exposedCount = engine.events.filter(
		(e) =>
			e.type === "experiment.Exposed" && e.data.experiment === experimentName,
	).length;
	return analysis.analyze(def, assignments, exposedCount);
}

// ---------------------------------------------------------------------------
// Unified ranked provider selection for evaluation
// ---------------------------------------------------------------------------

export type MediatedFlagEvaluator = Readonly<{
	backend: FeatureFlagBackendRank;
	evaluate(
		flagKey: string,
		context: FlagEvalContext,
		defaultValue?: FlagValue,
	): DetailEvaluation | Promise<DetailEvaluation>;
}>;

/**
 * Build a mediated evaluator: prefers built-in store; residual OFREP only when ranked available.
 */
export function createMediatedFlagEvaluator(options: {
	readonly store: FeatureFlagStore;
	readonly residual?: ReturnType<typeof createOfrepResidualBackend>;
	readonly residualAvailable?: boolean;
}): MediatedFlagEvaluator {
	const candidates: RankedBackend[] = [
		Object.freeze({
			id: "local-builtin" as const,
			available: true,
			mediated: false,
		}),
	];
	if (options.residual && options.residualAvailable) {
		candidates.push(
			Object.freeze({
				id: options.residual.id,
				available: true,
				mediated: true,
			}),
		);
	}
	const backend = selectFeatureFlagBackend(candidates);
	return Object.freeze({
		backend,
		evaluate(flagKey, context, defaultValue = false) {
			if (backend === "local-builtin" || !options.residual) {
				return options.store.evaluate(flagKey, context, defaultValue);
			}
			return options.residual.evaluate({
				flagKey,
				context,
				defaultValue,
			});
		},
	});
}

export { BuiltInStore, FEATURE_FLAG_BACKEND_RANKS, selectFeatureFlagBackend };

function digestCtx(context: FlagEvalContext): string {
	return `sha256:${createHash("sha256")
		.update(`${context.tenant ?? ""}:${context.targetingKey}`)
		.digest("hex")
		.slice(0, 16)}`;
}
