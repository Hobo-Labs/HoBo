// Prometheus HTTP API health source: GET /api/v1/query_range with the step
// aligned to the window. The query is PromQL as authored; the cohort is
// selected from the returned matrix by the declared label (no query
// templating), so the expression must keep that label, e.g.
// `sum by (track) (rate(http_requests_total{code=~"5.."}[1m]))`.

import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import { isJsonArray, isJsonObject } from "../json.js";
import {
	byKey,
	cohortSelector,
	credentialFor,
	httpsEndpoint,
	invalid,
	requestJson,
	type SourceDeps,
	samplesOutcome,
	sampleValue,
	stableKey,
} from "./http.js";

/** At most this many points per series; the step grows with the window. */
export const PROMETHEUS_MAX_POINTS = 60;
export const PROMETHEUS_MIN_STEP_SECONDS = 15;

/** Step in whole seconds that divides the window into at most 60 points. */
export function prometheusStepSeconds(fromMs: number, toMs: number): number {
	const windowSeconds = Math.max(1, Math.floor((toMs - fromMs) / 1000));
	return Math.max(
		PROMETHEUS_MIN_STEP_SECONDS,
		Math.ceil(windowSeconds / PROMETHEUS_MAX_POINTS),
	);
}

export function createPrometheusSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.PROMETHEUS,
		async query(input) {
			const { query } = input;
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const step = prometheusStepSeconds(input.fromMs, input.toMs);
			// Align start and end to the step so the same window always asks for the same points.
			const start = Math.floor(input.fromMs / 1000 / step) * step;
			const end = Math.floor(input.toMs / 1000 / step) * step;
			const url = new URL(
				`${endpoint.value.pathname.replace(/\/$/, "")}/api/v1/query_range`,
				endpoint.value,
			);
			url.searchParams.set("query", query.query);
			url.searchParams.set("start", String(start));
			url.searchParams.set("end", String(end));
			url.searchParams.set("step", `${step}s`);
			const response = await requestJson(deps, {
				method: "GET",
				url,
				headers: credential.value,
				subject: query.name,
			});
			if (!response.ok) return response;
			const body = response.value;
			if (
				!isJsonObject(body) ||
				body.status !== "success" ||
				!isJsonObject(body.data) ||
				body.data.resultType !== "matrix" ||
				!isJsonArray(body.data.result)
			) {
				return invalid(
					query.name,
					"Prometheus answer is not a successful matrix",
				);
			}
			const series: Array<Readonly<{ key: string; values: number[] }>> = [];
			for (const item of body.data.result) {
				if (
					!isJsonObject(item) ||
					!isJsonObject(item.metric) ||
					!isJsonArray(item.values)
				)
					return invalid(query.name, "malformed Prometheus series");
				if (
					selector.value &&
					item.metric[selector.value.label] !== selector.value.value
				)
					continue;
				const values: number[] = [];
				for (const point of item.values) {
					if (!isJsonArray(point) || point.length !== 2)
						return invalid(query.name, "malformed Prometheus point");
					const value = sampleValue(point[1]);
					if (value !== undefined) values.push(value);
				}
				series.push({ key: stableKey(item.metric), values });
			}
			series.sort(byKey);
			return samplesOutcome(
				series.flatMap((item) => item.values),
				input.fromMs,
				input.toMs,
			);
		},
	};
}
