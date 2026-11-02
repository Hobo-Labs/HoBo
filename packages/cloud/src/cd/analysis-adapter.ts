/**
 * Optional progressive-analysis residual adapters (Flagger/Argo-Rollouts-shaped).
 * Complete fail-soft ports — never hard deps, never ambient credentials.
 * Built-in analysis uses Harness health samples (SLO/Golden/guardrail).
 */
import type { DeliveryHealthSignal } from "@hobo/identity";
import { type JsonValue } from "../json.js";


// public-contract: progressive analysis adapter schema.
export const PROGRESSIVE_ANALYSIS_SCHEMA =
	"hobo.progressive-analysis/v1" as const;

export type ProgressiveAnalysisVerdict = "promote" | "hold" | "rollback";

export type ProgressiveAnalysisResult = Readonly<{
	schemaVersion: typeof PROGRESSIVE_ANALYSIS_SCHEMA;
	verdict: ProgressiveAnalysisVerdict;
	adapter: "builtin" | "flagger-shaped" | "argo-rollouts-shaped";
	reason: string;
	/** Secret-free attributes only. */
	attributes: Readonly<Record<string, string | number | boolean>>;
}>;

export type ProgressiveAnalysisPort = Readonly<{
	readonly kind: ProgressiveAnalysisResult["adapter"];
	analyze(input: {
		readonly samples: readonly DeliveryHealthSignal[];
		readonly stagePercent: number;
	}): Promise<ProgressiveAnalysisResult>;
}>;

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

/**
 * Built-in analysis: sustained healthy samples → promote; any burn/fail → rollback.
 */
export function createBuiltinProgressiveAnalysis(): ProgressiveAnalysisPort {
	return Object.freeze({
		kind: "builtin" as const,
		async analyze(input) {
			const unhealthy = input.samples.some(
				(s) =>
					s.sloBurning === true ||
					s.goldenFailed === true ||
					s.guardrailRegressed === true,
			);
			if (unhealthy) {
				return Object.freeze({
					schemaVersion: PROGRESSIVE_ANALYSIS_SCHEMA,
					verdict: "rollback" as const,
					adapter: "builtin" as const,
					reason: "slo-or-golden-or-guardrail-failed",
					attributes: Object.freeze({
						stagePercent: input.stagePercent,
						sampleCount: input.samples.length,
					}),
				});
			}
			if (input.samples.length < 2) {
				return Object.freeze({
					schemaVersion: PROGRESSIVE_ANALYSIS_SCHEMA,
					verdict: "hold" as const,
					adapter: "builtin" as const,
					reason: "awaiting-sustained-evidence",
					attributes: Object.freeze({
						stagePercent: input.stagePercent,
						sampleCount: input.samples.length,
						requiredSamples: 2,
					}),
				});
			}
			return Object.freeze({
				schemaVersion: PROGRESSIVE_ANALYSIS_SCHEMA,
				verdict: "promote" as const,
				adapter: "builtin" as const,
				reason: "sustained-healthy-samples",
				attributes: Object.freeze({
					stagePercent: input.stagePercent,
					sampleCount: input.samples.length,
				}),
			});
		},
	});
}

/**
 * Residual Flagger/Argo-shaped HTTP analysis. Fail-soft to built-in on transport error.
 * Never receives ambient credentials — caller mediates any auth headers.
 */
export function createResidualProgressiveAnalysis(options: {
	readonly kind: "flagger-shaped" | "argo-rollouts-shaped";
	readonly webhookUrl: string;
	readonly fetchImpl?: FetchLike;
	readonly headers?: Readonly<Record<string, string>>;
	readonly fallback?: ProgressiveAnalysisPort;
}): ProgressiveAnalysisPort {
	const fallback = options.fallback ?? createBuiltinProgressiveAnalysis();
	// SAFETY: `const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);` is required at this I/O or test boundary.
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	return Object.freeze({
		kind: options.kind,
		async analyze(input) {
			try {
				const res = await fetchImpl(options.webhookUrl, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(options.headers),
					},
					body: JSON.stringify({
						type: "io.hobo.progressive.analysis",
						spec: {
							stagePercent: input.stagePercent,
							samples: input.samples,
						},
					}),
				});
				if (!res.ok) {
					const fb = await fallback.analyze(input);
					return Object.freeze({
						...fb,
						adapter: options.kind,
						reason: `${options.kind}-http-${res.status};fallback:${fb.reason}`,
					});
				}
				// SAFETY: `const body = (await res.json()) as {` is required at this I/O or test boundary.
				const body = (await res.json()) as {
					verdict?: ProgressiveAnalysisVerdict;
					reason?: string;
				};
				const verdict =
					body.verdict === "promote" ||
					body.verdict === "hold" ||
					body.verdict === "rollback"
						? body.verdict
						: "hold";
				return Object.freeze({
					schemaVersion: PROGRESSIVE_ANALYSIS_SCHEMA,
					verdict,
					adapter: options.kind,
					reason: body.reason ?? `${options.kind}-remote`,
					attributes: Object.freeze({
						stagePercent: input.stagePercent,
						sampleCount: input.samples.length,
						remote: true,
					}),
				});
			} catch (err) {
				const fb = await fallback.analyze(input);
				return Object.freeze({
					...fb,
					adapter: options.kind,
					reason: `${options.kind}-unavailable:${err instanceof Error ? err.message : String(err)};fallback:${fb.reason}`,
				});
			}
		},
	});
}

export function selectProgressiveAnalysis(
	candidates: readonly ProgressiveAnalysisPort[],
): ProgressiveAnalysisPort {
	const builtin = candidates.find((c) => c.kind === "builtin");
	if (builtin) return builtin;
	return candidates[0] ?? createBuiltinProgressiveAnalysis();
}
