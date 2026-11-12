// Optional external progressive analysis as a HealthSource. Two analysis
// webhook dialects are kept from the removed CD plane, minus its fail-open
// fallbacks — absent or malformed evidence is a refusal, which the
// verification engine treats as no data, so FAIL (I5):
//
//   status-gate  `analysis+status:https://…`  POST the stage context; a 2xx
//                answer is one passing sample (1), a 4xx one failing sample
//                (0), anything else is unavailable. (The webhook-gate dialect
//                progressive-delivery controllers use for canary analysis.)
//   json-metric  `analysis+metric:https://…`  GET a JSON document; the query
//                is a JSON pointer to a number or a numeric array, returned
//                as samples. (The web-metric dialect of analysis runs.)
//
// Any other endpoint_ref is delegated to the wrapped source of the same kind,
// so composing this wrapper around the built-in HTTP_JSON source keeps that
// source's behavior for every other query. Credentials are resolved for one
// scoped call and never logged or recorded (I9).
import type { HttpTransport, JsonValue } from "@hobo/core";
import { HealthSourceKind } from "../_generated/cd_pb.js";
import type {
	CredentialResolver,
	HealthSamples,
	HealthSource,
	Outcome,
} from "../ports.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	parseJsonText,
} from "./json.js";
import { refuse } from "./reasons.js";

// public-contract: endpoint_ref prefixes the analysis webhook source serves.
export const ANALYSIS_ENDPOINTS = Object.freeze({
	statusGate: "analysis+status:",
	jsonMetric: "analysis+metric:",
} as const);

const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 262_144;

export type AnalysisWebhookDeps = Readonly<{
	http: HttpTransport;
	credentials: CredentialResolver;
	/** The source this wrapper delegates every non-analysis query to. */
	base?: HealthSource;
}>;

/** RFC 6901 JSON pointer lookup. */
export function pointer(document: JsonValue, path: string): JsonValue | undefined {
	if (path === "") return document;
	if (!path.startsWith("/")) return undefined;
	let current: JsonValue | undefined = document;
	for (const raw of path.slice(1).split("/")) {
		const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (isJsonArray(current)) {
			const index = Number(token);
			current = Number.isInteger(index) ? current[index] : undefined;
		} else if (isJsonObject(current)) {
			current = current[token];
		} else return undefined;
		if (current === undefined) return undefined;
	}
	return current;
}

function numericSamples(value: JsonValue | undefined): readonly number[] | undefined {
	if (isJsonNumber(value) && Number.isFinite(value)) return [value];
	if (!isJsonArray(value) || value.length === 0) return undefined;
	const values = value.flatMap((v) => (isJsonNumber(v) && Number.isFinite(v) ? [v] : []));
	return values.length === value.length ? values : undefined;
}

function httpsUrl(ref: string): string | undefined {
	try {
		const url = new URL(ref);
		return url.protocol === "https:" && url.username === "" && url.password === ""
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

export function withAnalysisWebhooks(d: AnalysisWebhookDeps): HealthSource {
	const kind = d.base?.kind ?? HealthSourceKind.HTTP_JSON;

	async function headers(credentialRef: string, scope: string): Promise<Readonly<Record<string, string>>> {
		if (credentialRef === "") return {};
		return d.credentials.resolve(credentialRef, scope);
	}

	return {
		kind,
		async query(input, ctx): Promise<Outcome<HealthSamples>> {
			const ref = input.query.endpointRef;
			const statusGate = ref.startsWith(ANALYSIS_ENDPOINTS.statusGate);
			const jsonMetric = ref.startsWith(ANALYSIS_ENDPOINTS.jsonMetric);
			if (!statusGate && !jsonMetric) {
				if (d.base) return d.base.query(input, ctx);
				return refuse(
					"analysis-webhook-unconfigured",
					`endpoint_ref ${ref || "(empty)"} is not an analysis webhook`,
					input.campId,
				);
			}
			const url = httpsUrl(
				ref.slice((statusGate ? ANALYSIS_ENDPOINTS.statusGate : ANALYSIS_ENDPOINTS.jsonMetric).length),
			);
			if (!url)
				return refuse("analysis-webhook-unconfigured", "analysis webhook URL must be absolute https", input.campId);
			const window = { fromMs: input.fromMs, toMs: input.toMs };
			let auth: Readonly<Record<string, string>>;
			try {
				auth = await headers(input.query.credentialRef, `analysis:${input.campId}`);
			} catch {
				return refuse("analysis-webhook-unavailable", "analysis webhook credential did not resolve", input.campId);
			}
			try {
				if (statusGate) {
					const response = await d.http({
						method: "POST",
						url,
						headers: { "content-type": "application/json", ...auth },
						body: JSON.stringify({
							name: input.query.name,
							phase: "stage-boundary",
							metadata: {
								campId: input.campId,
								cohort: String(input.cohort),
								fromMs: String(input.fromMs),
								toMs: String(input.toMs),
							},
						}),
						timeoutMs: TIMEOUT_MS,
						maxResponseBytes: MAX_RESPONSE_BYTES,
					});
					if (response.status >= 200 && response.status < 300)
						return { ok: true, value: { values: [1], ...window } };
					if (response.status >= 400 && response.status < 500)
						return { ok: true, value: { values: [0], ...window } };
					return refuse("analysis-webhook-unavailable", `analysis webhook answered ${response.status}`, input.campId);
				}
				const response = await d.http({
					method: "GET",
					url,
					headers: { accept: "application/json", ...auth },
					timeoutMs: TIMEOUT_MS,
					maxResponseBytes: MAX_RESPONSE_BYTES,
				});
				if (response.status < 200 || response.status >= 300)
					return refuse("analysis-webhook-unavailable", `analysis metric answered ${response.status}`, input.campId);
				const document = parseJsonText(response.body);
				const values = document === undefined ? undefined : numericSamples(pointer(document, input.query.query));
				if (!values)
					return refuse(
						"analysis-webhook-unavailable",
						`analysis metric has no numeric value at ${input.query.query}`,
						input.campId,
					);
				return { ok: true, value: { values, ...window } };
			} catch {
				return refuse("analysis-webhook-unavailable", "analysis webhook transport failed", input.campId);
			}
		},
	};
}
